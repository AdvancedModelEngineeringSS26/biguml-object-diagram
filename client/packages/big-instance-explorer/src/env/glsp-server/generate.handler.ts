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
    GenerateInstancesOperation,
    GenerateInstancesPreviewResponse,
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
import { parseMultiplicity, toPropertyTypeKind } from './resolve.js';
import { PatternStrategy } from './strategies/pattern.strategy.js';
import { RandomStrategy } from './strategies/random.strategy.js';
import { type ValueStrategy } from './strategies/strategy.js';

type InstantiableClassifier = Class | DataType;

// Layout heuristics (mirrors CreateClassifierInstanceOperationHandler).
const INSTANCE_MIN_WIDTH = 120;
const INSTANCE_MIN_HEIGHT = 40;
const INSTANCE_HEADER_HEIGHT = 30;
const INSTANCE_SLOT_ROW_HEIGHT = 18;
const INSTANCE_NAME_CHAR_WIDTH = 8;
const INSTANCE_NAME_PADDING = 24;
const INSTANCE_PLACEMENT_GAP = 60;
const INSTANCE_FALLBACK_CLASSIFIER_WIDTH = 120;

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

function resolvePropertyView(property: Property): PropertyView {
    const typeRef = property.propertyType?.ref;
    const isEnum = isEnumeration(typeRef);
    const bounds = parseMultiplicity(property.multiplicity);
    return {
        id: property.__id,
        name: property.name,
        documentUri: property.$document?.uri.path,
        typeKind: toPropertyTypeKind(typeRef?.name, isEnum),
        typeName: typeRef?.name,
        enumLiterals: isEnum ? (typeRef.values ?? []).map(literal => literal.name) : undefined,
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

function buildLayoutOps(result: GenerationResult, modelState: DiagramModelState): PatchOperation[] {
    const elementUri = URI.parse(modelState.semanticUri).path;
    const perClassifier = new Map<string, number>();
    const ops: PatchOperation[] = [];

    for (const instance of result.instances) {
        const order = perClassifier.get(instance.classifierId) ?? 0;
        perClassifier.set(instance.classifierId, order + 1);

        const classifierPosition = modelState.index.findPosition(instance.classifierId);
        const classifierSize = modelState.index.findSize(instance.classifierId);
        const width = Math.max(INSTANCE_MIN_WIDTH, instance.name.length * INSTANCE_NAME_CHAR_WIDTH + INSTANCE_NAME_PADDING);
        const height = Math.max(INSTANCE_MIN_HEIGHT, INSTANCE_HEADER_HEIGHT + instance.slotCount * INSTANCE_SLOT_ROW_HEIGHT);
        const baseX = (classifierPosition?.x ?? 0) + (classifierSize?.width ?? INSTANCE_FALLBACK_CLASSIFIER_WIDTH) + INSTANCE_PLACEMENT_GAP;
        const baseY = classifierPosition?.y ?? 0;
        const y = baseY + order * (height + INSTANCE_PLACEMENT_GAP / 2);

        ops.push({
            op: 'add',
            path: '/metaInfos/-',
            value: { $type: 'Size', __id: `size_${instance.id}`, element: { $ref: { __id: instance.id, __documentUri: elementUri } }, width, height }
        });
        ops.push({
            op: 'add',
            path: '/metaInfos/-',
            value: { $type: 'Position', __id: `pos_${instance.id}`, element: { $ref: { __id: instance.id, __documentUri: elementUri } }, x: baseX, y }
        });
    }
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
    const linkable: LinkableInstance[] = result.instances.map(instance => ({
        id: instance.id,
        name: instance.name,
        classifierId: instance.classifierId,
        documentUri
    }));
    const links = planLinks(linkable, resolveAssociationViews(modelState), {
        depth: config.associationDepth,
        seed: config.seed,
        // When the user asks for links (depth >= 1), guarantee at least one per source so
        // optional (0..*) associations still produce visible links.
        minPerSource: config.associationDepth >= 1 ? 1 : 0,
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
