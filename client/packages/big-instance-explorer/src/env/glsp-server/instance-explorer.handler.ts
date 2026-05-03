/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/

import { createRandomUUID, findAvailableNodeName, type SerializeAstNode, type SerializedRecordNode } from '@borkdominik-biguml/uml-model-server';
import {
    type Class,
    type DataType,
    type InstanceSpecification,
    type Interface,
    type LiteralSpecification,
    type Property,
    type Slot,
    isClass,
    isDataType,
    isInstanceSpecification,
    isInterface,
    isProperty,
    isSlot
} from '@borkdominik-biguml/uml-model-server/grammar';
import {
    DiagramModelState,
    ModelPatchCommand,
    getDefaultProperties
} from '@borkdominik-biguml/uml-glsp-server/vscode';
import { ClassDiagramNodeTypes } from '@borkdominik-biguml/uml-glsp-server';
import { type ActionHandler, type Command, type MaybePromise, OperationHandler } from '@eclipse-glsp/server';
import { streamAst } from 'langium';
import { inject, injectable } from 'inversify';
import { URI } from 'vscode-uri';
import {
    CreateClassifierInstanceOperation,
    InstanceExplorerDataResponse,
    RequestInstanceExplorerDataAction,
    UpdateInstanceSlotValuesOperation,
    type ClassifierGroup,
    type ClassifierType,
    type DiagnosticSummary,
    type InstanceSummary,
    type SlotSummary
} from '../common/index.js';

type SupportedClassifier = Class | Interface | DataType;

interface ClassifierInfo {
    classifier: SupportedClassifier;
    classifierType: ClassifierType;
}

const INSTANCE_HEADER_HEIGHT = 34;
const INSTANCE_SLOT_ROW_HEIGHT = 22;
const INSTANCE_MIN_WIDTH = 170;
const INSTANCE_MIN_HEIGHT = 60;
const INSTANCE_NAME_CHAR_WIDTH = 10;
const INSTANCE_NAME_PADDING = 48;
const INSTANCE_PLACEMENT_GAP = 48;
const INSTANCE_FALLBACK_CLASSIFIER_WIDTH = 120;

@injectable()
export class RequestInstanceExplorerDataActionHandler implements ActionHandler {
    actionKinds = [RequestInstanceExplorerDataAction.KIND];

    @inject(DiagramModelState)
    protected readonly modelState: DiagramModelState;

    execute(_action: RequestInstanceExplorerDataAction): MaybePromise<any[]> {
        const classifiersById = this.collectClassifiers();
        const classifierGroups = new Map<string, ClassifierGroup>();
        const unclassified: InstanceSummary[] = [];

        for (const node of streamAst(this.modelState.semanticRoot)) {
            if (!isInstanceSpecification(node)) {
                continue;
            }

            const summary = this.summarizeInstance(node, classifiersById);
            if (summary.classifierId) {
                const info = classifiersById.get(summary.classifierId)!;
                let group = classifierGroups.get(summary.classifierId);
                if (!group) {
                    group = {
                        classifierId: info.classifier.__id,
                        classifierName: info.classifier.name,
                        classifierType: info.classifierType,
                        instances: []
                    };
                    classifierGroups.set(summary.classifierId, group);
                }
                group.instances.push(summary);
            } else {
                unclassified.push(summary);
            }
        }

        const groups = Array.from(classifierGroups.values())
            .map(group => ({
                ...group,
                instances: group.instances.sort(compareInstances)
            }))
            .sort((left, right) => left.classifierName.localeCompare(right.classifierName));

        return [
            InstanceExplorerDataResponse.create({
                classifierGroups: groups,
                unclassified: unclassified.sort(compareInstances)
            })
        ];
    }

    protected collectClassifiers(): Map<string, ClassifierInfo> {
        const byId = new Map<string, ClassifierInfo>();
        for (const node of streamAst(this.modelState.semanticRoot)) {
            if (!isSupportedClassifier(node)) {
                continue;
            }
            byId.set(node.__id, { classifier: node, classifierType: classifierTypeOf(node) });
        }
        return byId;
    }

    protected summarizeInstance(instance: InstanceSpecification, classifiersById: Map<string, ClassifierInfo>): InstanceSummary {
        const diagnostics: DiagnosticSummary[] = [];
        const slotSummaries = instance.slots.map(slot => this.summarizeSlot(slot));

        const directClassifier = instance.classifier?.ref;
        const resolvedClassifier =
            directClassifier && isSupportedClassifier(directClassifier) ? classifiersById.get(directClassifier.__id) : undefined;

        if (!resolvedClassifier) {
            diagnostics.push({
                severity: 'warning',
                message: 'Instance has no classifier set.'
            });
        } else {
            const matchedPropertyIds = new Set<string>();
            for (const slotSummary of slotSummaries) {
                const slot = this.modelState.index.findSemanticElement(slotSummary.id, isSlot);
                const feature = slot?.definingFeature?.ref;
                if (!isProperty(feature)) continue;
                matchedPropertyIds.add(feature.__id);

                const owner = owningClassifier(feature);
                if (owner && owner.__id !== resolvedClassifier.classifier.__id) {
                    slotSummary.diagnostics.push({
                        severity: 'warning',
                        message: `Slot belongs to ${owner.name}, not to ${resolvedClassifier.classifier.name}.`
                    });
                }
            }

            const missingProperties = resolvedClassifier.classifier.properties.filter(
                property => !matchedPropertyIds.has(property.__id)
            );
            if (missingProperties.length > 0) {
                diagnostics.push({
                    severity: 'warning',
                    message: `Missing slots for classifier properties: ${missingProperties.map(property => property.name).join(', ')}.`
                });
            }
        }

        return {
            id: instance.__id,
            name: instance.name,
            classifierId: resolvedClassifier?.classifier.__id,
            classifierName: resolvedClassifier?.classifier.name,
            slots: slotSummaries.sort((left, right) => left.featureName.localeCompare(right.featureName)),
            diagnostics
        };
    }

    protected summarizeSlot(slot: Slot): SlotSummary {
        const diagnostics: DiagnosticSummary[] = [];
        const feature = slot.definingFeature?.ref;
        const values = slot.values.map(value => value.value ?? value.name ?? '');
        let featureName = slot.name || '(unnamed slot)';

        if (!feature) {
            diagnostics.push({
                severity: 'warning',
                message: 'Slot has no defining feature.'
            });
        } else if (isProperty(feature)) {
            featureName = feature.name || featureName;
            if (!owningClassifier(feature)) {
                diagnostics.push({
                    severity: 'warning',
                    message: 'Slot defining feature is not owned by a supported classifier.'
                });
            }

            const multiplicityDiagnostic = multiplicityDiagnosticFor(feature, values.length);
            if (multiplicityDiagnostic) {
                diagnostics.push(multiplicityDiagnostic);
            }
        } else if (isClass(feature) || isInterface(feature)) {
            featureName = feature.name || featureName;
            diagnostics.push({
                severity: 'warning',
                message: 'Slot defining feature points to a classifier directly instead of a property.'
            });
        } else {
            diagnostics.push({
                severity: 'warning',
                message: 'Slot defining feature could not be resolved.'
            });
        }

        return {
            id: slot.__id,
            featureName,
            values,
            diagnostics
        };
    }
}

@injectable()
export class CreateClassifierInstanceOperationHandler extends OperationHandler {
    override operationType = CreateClassifierInstanceOperation.KIND;

    declare readonly modelState: DiagramModelState;

    override createCommand(operation: CreateClassifierInstanceOperation): Command | undefined {
        const classifier = this.modelState.index.findIdElement(operation.classifierId);
        if (!isSupportedClassifier(classifier)) {
            return undefined;
        }

        const instanceId = createRandomUUID();
        const baseName = findAvailableNodeName(this.modelState.semanticRoot, `New${classifier.name}`);
        const instanceName = baseName;
        const containerPath = '/diagram/entities/-';

        const instanceValue: SerializedRecordNode = {
            $type: 'InstanceSpecification',
            __id: instanceId,
            name: instanceName,
            classifier: {
                ref: { __id: classifier.__id, __documentUri: classifier.$document?.uri },
                $refText: classifier.name
            },
            slots: classifier.properties.map(property => createSlotValue(property))
        };

        for (const { property, defaultValue } of getDefaultProperties(ClassDiagramNodeTypes.INSTANCE_SPECIFICATION)) {
            if (property !== 'name' && property !== 'slots' && instanceValue[property] === undefined) {
                instanceValue[property] = defaultValue;
            }
        }

        const classifierPosition = this.modelState.index.findPosition(classifier.__id);
        const classifierSize = this.modelState.index.findSize(classifier.__id);
        const width = Math.max(INSTANCE_MIN_WIDTH, classifier.name.length * INSTANCE_NAME_CHAR_WIDTH + INSTANCE_NAME_PADDING);
        const height = Math.max(INSTANCE_MIN_HEIGHT, INSTANCE_HEADER_HEIGHT + classifier.properties.length * INSTANCE_SLOT_ROW_HEIGHT);
        const x = (classifierPosition?.x ?? 0) + (classifierSize?.width ?? INSTANCE_FALLBACK_CLASSIFIER_WIDTH) + INSTANCE_PLACEMENT_GAP;
        const y = classifierPosition?.y ?? 0;

        const patch = [
            {
                op: 'add' as const,
                path: containerPath,
                value: instanceValue as SerializeAstNode<InstanceSpecification>
            },
            {
                op: 'add' as const,
                path: '/metaInfos/-',
                value: {
                    $type: 'Size',
                    __id: `size_${instanceId}`,
                    element: { $ref: { __id: instanceId, __documentUri: URI.parse(this.modelState.semanticUri).path } },
                    width,
                    height
                }
            },
            {
                op: 'add' as const,
                path: '/metaInfos/-',
                value: {
                    $type: 'Position',
                    __id: `pos_${instanceId}`,
                    element: { $ref: { __id: instanceId, __documentUri: URI.parse(this.modelState.semanticUri).path } },
                    x,
                    y
                }
            }
        ];

        return new ModelPatchCommand(this.modelState, JSON.stringify(patch));
    }
}

@injectable()
export class UpdateInstanceSlotValuesOperationHandler extends OperationHandler {
    override operationType = UpdateInstanceSlotValuesOperation.KIND;

    declare readonly modelState: DiagramModelState;

    override createCommand(operation: UpdateInstanceSlotValuesOperation): Command | undefined {
        const slot = this.modelState.index.findSemanticElement(operation.slotId, isSlot);
        const slotPath = this.modelState.index.findPath(operation.slotId);
        if (!slot || !slotPath) {
            return undefined;
        }

        const serializedValues = operation.values.map((value, index) => ({
            $type: 'LiteralSpecification',
            __id: slot.values[index]?.__id ?? createRandomUUID(),
            name: slot.values[index]?.name ?? `value${index + 1}`,
            value
        }));

        return new ModelPatchCommand(
            this.modelState,
            JSON.stringify([
                {
                    op: 'add',
                    path: `${slotPath}/values`,
                    value: serializedValues as SerializeAstNode<LiteralSpecification>[]
                }
            ])
        );
    }
}

function classifierTypeOf(classifier: SupportedClassifier): ClassifierType {
    if (isInterface(classifier)) {
        return 'Interface';
    }
    if (isDataType(classifier)) {
        return 'DataType';
    }
    return 'Class';
}

function isSupportedClassifier(value: unknown): value is SupportedClassifier {
    return isClass(value) || isInterface(value) || isDataType(value);
}

function owningClassifier(property: Property): SupportedClassifier | undefined {
    return isSupportedClassifier(property.$container) ? property.$container : undefined;
}

function multiplicityDiagnosticFor(property: Property, valueCount: number): DiagnosticSummary | undefined {
    const multiplicity = property.multiplicity?.trim();
    if (!multiplicity) {
        return undefined;
    }

    const range = parseMultiplicity(multiplicity);
    if (!range) {
        return undefined;
    }

    if (valueCount < range.min) {
        return {
            severity: 'warning',
            message: `Expected at least ${range.min} value(s) for ${property.name}, but found ${valueCount}.`
        };
    }

    if (range.max !== undefined && valueCount > range.max) {
        return {
            severity: 'warning',
            message: `Expected at most ${range.max} value(s) for ${property.name}, but found ${valueCount}.`
        };
    }

    return undefined;
}

function parseMultiplicity(multiplicity: string): { min: number; max?: number } | undefined {
    if (multiplicity === '*') {
        return { min: 0 };
    }

    if (/^\d+$/.test(multiplicity)) {
        const amount = Number(multiplicity);
        return { min: amount, max: amount };
    }

    const match = multiplicity.match(/^(\d+)\.\.(\d+|\*)$/);
    if (!match) {
        return undefined;
    }

    return {
        min: Number(match[1]),
        max: match[2] === '*' ? undefined : Number(match[2])
    };
}

function compareInstances(left: InstanceSummary, right: InstanceSummary): number {
    return left.name.localeCompare(right.name);
}

function createSlotValue(property: Property): SerializedRecordNode {
    return {
        $type: 'Slot',
        __id: createRandomUUID(),
        name: property.name,
        definingFeature: {
            ref: {
                __id: property.__id,
                __documentUri: property.$document?.uri
            },
            $refText: property.name
        },
        values: []
    };
}
