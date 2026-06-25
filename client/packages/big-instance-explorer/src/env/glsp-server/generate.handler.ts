/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/
import { createRandomUUID } from '@borkdominik-biguml/uml-model-server';
import {
    isAssociation,
    isClass,
    isDataType,
    isEnumeration,
    isGeneralization,
    isInstanceSpecification,
    isInterface,
    isInterfaceRealization,
    isProperty,
    type Association,
    type Class,
    type DataType,
    type Interface,
    type Property
} from '@borkdominik-biguml/uml-model-server/grammar';
import { ClassDiagramEdgeTypes, ClassDiagramNodeTypes } from '@borkdominik-biguml/uml-glsp-server';
import { DiagramModelState, ModelPatchCommand, getDefaultProperties } from '@borkdominik-biguml/uml-glsp-server/vscode';
import { type ActionHandler, type Command, type MaybePromise, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { streamAst } from 'langium';
import { URI } from 'vscode-uri';
import {
    GeneratableClassifiersResponse,
    GenerateInstancesOperation,
    GenerateInstancesPreviewResponse,
    RequestGeneratableClassifiersAction,
    RequestGenerateInstancesPreviewAction,
    type GenerationConfig,
    type GenerationResultSummary
} from '../common/generate.action.js';
import {
    buildGeneration,
    extractPreviewSample,
    type ClassifierView,
    type GenerationResult,
    type PatchOperation,
    type PropertyView
} from './generate.core.js';
import { planLinks, type AssociationView, type LinkPlanResult, type LinkableInstance } from './links.core.js';
import { parseMultiplicity, resolveTypeKind, type TypeCategory } from './resolve.js';
import { PatternStrategy } from './strategies/pattern.strategy.js';
import { RandomStrategy } from './strategies/random.strategy.js';
import { RealisticStrategy } from './strategies/realistic.strategy.js';
import { type ValueStrategy } from './strategies/strategy.js';

type InstantiableClassifier = Class | DataType;

// Layout heuristics. Generated instances are placed in a non-overlapping grid in
// empty space below the existing diagram, so they never pile up on each other or on
// the class diagram and remain individually draggable.
const INSTANCE_MIN_WIDTH = 160;
const INSTANCE_MIN_HEIGHT = 50;
const INSTANCE_HEADER_HEIGHT = 30;
const INSTANCE_SLOT_ROW_HEIGHT = 18;
const INSTANCE_NAME_CHAR_WIDTH = 8;
const INSTANCE_NAME_PADDING = 24;
const GRID_COLUMNS = 4;
const GRID_START_X = 40;
const GRID_COLUMN_SPACING = 60;
const GRID_ROW_SPACING = 50;
const GRID_TOP_MARGIN = 160;

function isInstantiableClassifier(node: unknown): node is InstantiableClassifier {
    if (isInterface(node)) {
        return false;
    }
    if (isClass(node)) {
        return node.isAbstract !== true;
    }
    return isDataType(node);
}

function propertiesOf(classifier: Class | DataType | Interface): Property[] {
    const owned = (classifier as { properties?: unknown }).properties;
    return Array.isArray(owned) ? owned.filter(isProperty) : [];
}

/** Collects a classifier and its supertypes (via Generalization / InterfaceRealization). */
function collectHierarchy(start: InstantiableClassifier, modelState: DiagramModelState): (Class | DataType | Interface)[] {
    const relations = modelState.semanticRoot.diagram.relations ?? [];
    const visited = new Set<unknown>();
    const queue: (Class | DataType | Interface)[] = [start];
    const result: (Class | DataType | Interface)[] = [];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) {
            continue;
        }
        visited.add(current);
        result.push(current);

        for (const relation of relations) {
            if (!isGeneralization(relation) && !isInterfaceRealization(relation)) {
                continue;
            }
            if (relation.source?.ref !== current) {
                continue;
            }
            const parent = relation.target?.ref;
            if (isClass(parent) || isDataType(parent) || isInterface(parent)) {
                queue.push(parent);
            }
        }
    }
    return result;
}

function typeCategory(typeRef: unknown): TypeCategory {
    if (!typeRef) {
        return 'none';
    }
    if (isEnumeration(typeRef)) {
        return 'enumeration';
    }
    if (isClass(typeRef) || isInterface(typeRef)) {
        return 'classifier';
    }
    // DataType or PrimitiveType -> a value-bearing type.
    return 'datatype';
}

function resolvePropertyView(property: Property): PropertyView {
    const typeRef = property.propertyType?.ref;
    const category = typeCategory(typeRef);
    const bounds = parseMultiplicity(property.multiplicity);
    return {
        id: property.__id,
        name: property.name,
        documentUri: property.$document?.uri.path,
        typeKind: resolveTypeKind(category, typeRef?.name),
        typeName: typeRef?.name,
        enumLiterals: category === 'enumeration' && isEnumeration(typeRef) ? (typeRef.values ?? []).map(literal => literal.name) : undefined,
        isReadOnly: property.isReadOnly === true,
        isUnique: property.isUnique === true,
        required: bounds.lower >= 1
    };
}

function resolveClassifierView(classifier: InstantiableClassifier, modelState: DiagramModelState): ClassifierView {
    const properties = collectHierarchy(classifier, modelState).flatMap(propertiesOf).map(resolvePropertyView);
    return {
        id: classifier.__id,
        name: classifier.name,
        documentUri: classifier.$document?.uri.path,
        properties
    };
}

function resolveAssociationViews(modelState: DiagramModelState): AssociationView[] {
    const relations = modelState.semanticRoot.diagram.relations ?? [];
    const views: AssociationView[] = [];
    for (const relation of relations) {
        if (!isAssociation(relation)) {
            continue;
        }
        const source = relation.source?.ref;
        const target = relation.target?.ref;
        if (!isInstantiableClassifier(source) || !isInstantiableClassifier(target)) {
            continue;
        }
        // No selection filter here: planLinks only creates links between classifiers that
        // actually have generated instances, so including every association is safe and
        // avoids dropping links when the user didn't tick both ends.
        const bounds = parseMultiplicity((relation as Association).targetMultiplicity);
        views.push({
            id: relation.__id,
            name: relation.name,
            documentUri: relation.$document?.uri.path,
            sourceClassifierId: source.__id,
            targetClassifierId: target.__id,
            targetLowerBound: bounds.lower,
            targetUpperBound: bounds.upper
        });
    }
    return views;
}

function makeStrategy(config: GenerationConfig): ValueStrategy {
    if (config.strategy === 'pattern') {
        return new PatternStrategy({ patterns: config.patterns ?? {} });
    }
    if (config.strategy === 'realistic') {
        return new RealisticStrategy(config.seed ?? 0);
    }
    return new RandomStrategy();
}

function collectExistingInstanceNames(modelState: DiagramModelState): string[] {
    const names: string[] = [];
    for (const node of streamAst(modelState.semanticRoot)) {
        if (isInstanceSpecification(node) && node.name) {
            names.push(node.name);
        }
    }
    return names;
}

/** Existing instances already in the model, as link candidates (so generated instances can link to them). */
function collectExistingLinkableInstances(modelState: DiagramModelState): LinkableInstance[] {
    const documentUri = URI.parse(modelState.semanticUri).path;
    const instances: LinkableInstance[] = [];
    for (const node of streamAst(modelState.semanticRoot)) {
        if (isInstanceSpecification(node)) {
            const classifierId = node.classifier?.ref?.__id;
            if (classifierId) {
                instances.push({ id: node.__id, name: node.name, classifierId, documentUri });
            }
        }
    }
    return instances;
}

/** Applies generated defaults to every node value of the given kind, leaving explicit fields untouched. */
function applyDefaults(values: Record<string, unknown>[], elementType: string, skip: ReadonlySet<string>): void {
    const defaults = getDefaultProperties(elementType);
    for (const value of values) {
        for (const { property, defaultValue } of defaults) {
            if (!skip.has(property) && value[property] === undefined) {
                value[property] = defaultValue;
            }
        }
    }
}

/** Bottom Y of the existing diagram, so new instances can be placed below it in empty space. */
function existingDiagramBottom(modelState: DiagramModelState): number {
    let bottom = 0;
    for (const metaInfo of (modelState.semanticRoot.metaInfos ?? []) as { y?: unknown }[]) {
        if (typeof metaInfo.y === 'number') {
            bottom = Math.max(bottom, metaInfo.y);
        }
    }
    return bottom;
}

function buildLayoutOps(result: GenerationResult, modelState: DiagramModelState): PatchOperation[] {
    const elementUri = URI.parse(modelState.semanticUri).path;
    const ops: PatchOperation[] = [];

    const sizeOf = (slotCount: number): number => Math.max(INSTANCE_MIN_HEIGHT, INSTANCE_HEADER_HEIGHT + slotCount * INSTANCE_SLOT_ROW_HEIGHT);
    const widthOf = (name: string): number => Math.max(INSTANCE_MIN_WIDTH, name.length * INSTANCE_NAME_CHAR_WIDTH + INSTANCE_NAME_PADDING);

    // Uniform grid: column width = widest instance, row height = tallest instance, so nothing overlaps.
    const columnWidth = Math.max(INSTANCE_MIN_WIDTH, ...result.instances.map(instance => widthOf(instance.name))) + GRID_COLUMN_SPACING;
    const rowHeight = Math.max(INSTANCE_MIN_HEIGHT, ...result.instances.map(instance => sizeOf(instance.slotCount))) + GRID_ROW_SPACING;
    const startY = existingDiagramBottom(modelState) + GRID_TOP_MARGIN;

    result.instances.forEach((instance, index) => {
        const column = index % GRID_COLUMNS;
        const row = Math.floor(index / GRID_COLUMNS);
        const x = GRID_START_X + column * columnWidth;
        const y = startY + row * rowHeight;
        const width = widthOf(instance.name);
        const height = sizeOf(instance.slotCount);

        ops.push({
            op: 'add',
            path: '/metaInfos/-',
            value: { $type: 'Size', __id: `size_${instance.id}`, element: { $ref: { __id: instance.id, __documentUri: elementUri } }, width, height }
        });
        ops.push({
            op: 'add',
            path: '/metaInfos/-',
            value: { $type: 'Position', __id: `pos_${instance.id}`, element: { $ref: { __id: instance.id, __documentUri: elementUri } }, x, y }
        });
    });
    return ops;
}

interface RunResult {
    result: GenerationResult;
    links: LinkPlanResult;
}

/** Resolves views and runs the pure generation + link planning for the given config. */
function run(config: GenerationConfig, modelState: DiagramModelState): RunResult {
    const classifierViews = config.classifierIds
        .map(id => modelState.index.findIdElement(id))
        .filter(isInstantiableClassifier)
        .map(classifier => resolveClassifierView(classifier, modelState));

    const result = buildGeneration(classifierViews, {
        count: config.countPerClassifier,
        strategy: makeStrategy(config),
        seed: config.seed,
        reservedNames: collectExistingInstanceNames(modelState),
        idFactory: createRandomUUID
    });

    const documentUri = URI.parse(modelState.semanticUri).path;
    const generated: LinkableInstance[] = result.instances.map(instance => ({
        id: instance.id,
        name: instance.name,
        classifierId: instance.classifierId,
        documentUri
    }));
    // Pool = existing instances + the newly generated ones, so generated instances can be
    // linked to instances that already exist in the model (e.g. new Employees -> existing Company).
    const pool = [...collectExistingLinkableInstances(modelState), ...generated];
    const links = planLinks(pool, resolveAssociationViews(modelState), {
        depth: config.associationDepth,
        seed: config.seed,
        // When the user asks for links (depth >= 1), guarantee at least one per source so
        // optional (0..*) associations still produce visible links.
        minPerSource: config.associationDepth >= 1 ? 1 : 0,
        // Only originate links from the newly generated instances; never add links to
        // pre-existing instances' source ends.
        sourceIds: new Set(generated.map(instance => instance.id)),
        idFactory: createRandomUUID
    });

    return { result, links };
}

const PREVIEW_SAMPLE_LIMIT = 10;

function summarize({ result, links }: RunResult): GenerationResultSummary {
    return {
        instanceCount: result.instances.length,
        slotCount: result.instances.reduce((sum, instance) => sum + instance.slotCount, 0),
        linkCount: links.links.length,
        diagnostics: [...result.diagnostics, ...links.diagnostics].map(d => ({ code: d.code, severity: d.severity, message: d.message })),
        sample: extractPreviewSample(result.patch, PREVIEW_SAMPLE_LIMIT)
    };
}

/** Applies generated instances/slots/links as one atomic, undoable model patch. */
@injectable()
export class GenerateInstancesOperationHandler extends OperationHandler {
    override operationType = GenerateInstancesOperation.KIND;

    declare readonly modelState: DiagramModelState;

    override createCommand(operation: GenerateInstancesOperation): Command | undefined {
        const { result, links } = run(operation.config, this.modelState);
        if (result.patch.length === 0) {
            return undefined;
        }

        const instanceValues = result.patch.map(op => op.value as Record<string, unknown>);
        applyDefaults(instanceValues, ClassDiagramNodeTypes.INSTANCE_SPECIFICATION, new Set(['name', 'slots', 'classifier']));
        applyDefaults(
            links.patch.map(op => op.value as Record<string, unknown>),
            ClassDiagramEdgeTypes.INSTANCE_LINK,
            new Set(['name', 'source', 'target', 'association', 'relationType'])
        );

        const patch = [...result.patch, ...buildLayoutOps(result, this.modelState), ...links.patch];
        return new ModelPatchCommand(this.modelState, JSON.stringify(patch));
    }
}

/** Read-only preview: returns counts and diagnostics without mutating the model. */
@injectable()
export class GenerateInstancesPreviewActionHandler implements ActionHandler {
    actionKinds = [RequestGenerateInstancesPreviewAction.KIND];

    @inject(DiagramModelState)
    protected readonly modelState: DiagramModelState;

    execute(action: RequestGenerateInstancesPreviewAction): MaybePromise<GenerateInstancesPreviewResponse[]> {
        const summary = summarize(run(action.config, this.modelState));
        return [GenerateInstancesPreviewResponse.create({ responseId: action.requestId, summary })];
    }
}

/** Returns the instantiable classifiers and their generatable (non-read-only) properties for the UI. */
@injectable()
export class GeneratableClassifiersActionHandler implements ActionHandler {
    actionKinds = [RequestGeneratableClassifiersAction.KIND];

    @inject(DiagramModelState)
    protected readonly modelState: DiagramModelState;

    execute(action: RequestGeneratableClassifiersAction): MaybePromise<GeneratableClassifiersResponse[]> {
        const seen = new Set<string>();
        const classifiers = [];
        for (const node of streamAst(this.modelState.semanticRoot)) {
            if (!isInstantiableClassifier(node) || seen.has(node.__id)) {
                continue;
            }
            seen.add(node.__id);
            const view = resolveClassifierView(node, this.modelState);
            classifiers.push({
                classifierId: view.id,
                classifierName: view.name,
                properties: view.properties.filter(p => !p.isReadOnly).map(p => ({ name: p.name, typeName: p.typeName }))
            });
        }
        classifiers.sort((left, right) => left.classifierName.localeCompare(right.classifierName));
        return [GeneratableClassifiersResponse.create({ responseId: action.requestId, classifiers })];
    }
}
