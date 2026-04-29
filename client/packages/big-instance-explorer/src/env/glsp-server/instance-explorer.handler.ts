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

@injectable()
export class RequestInstanceExplorerDataActionHandler implements ActionHandler {
    actionKinds = [RequestInstanceExplorerDataAction.KIND];

    @inject(DiagramModelState)
    protected readonly modelState: DiagramModelState;

    execute(_action: RequestInstanceExplorerDataAction): MaybePromise<any[]> {
        const classifiers = this.collectClassifiers();
        const classifierGroups = new Map<string, ClassifierGroup>();
        const unclassified: InstanceSummary[] = [];

        for (const node of streamAst(this.modelState.semanticRoot)) {
            if (!isInstanceSpecification(node)) {
                continue;
            }

            const summary = this.summarizeInstance(node, classifiers.byId, classifiers.byName);
            if (summary.classifierId) {
                const info = classifiers.byId.get(summary.classifierId);
                if (info) {
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
                    continue;
                }
            }

            unclassified.push(summary);
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

    protected collectClassifiers(): { byId: Map<string, ClassifierInfo>; byName: Map<string, ClassifierInfo[]> } {
        const byId = new Map<string, ClassifierInfo>();
        const byName = new Map<string, ClassifierInfo[]>();

        for (const node of streamAst(this.modelState.semanticRoot)) {
            if (!isSupportedClassifier(node)) {
                continue;
            }

            const classifierType = classifierTypeOf(node);
            const entry: ClassifierInfo = {
                classifier: node,
                classifierType
            };

            byId.set(node.__id, entry);

            const key = node.name.trim().toLowerCase();
            const list = byName.get(key) ?? [];
            list.push(entry);
            byName.set(key, list);
        }

        return { byId, byName };
    }

    protected summarizeInstance(
        instance: InstanceSpecification,
        classifiersById: Map<string, ClassifierInfo>,
        classifiersByName: Map<string, ClassifierInfo[]>
    ): InstanceSummary {
        const diagnostics: DiagnosticSummary[] = [];
        const classifierMatches = new Map<string, Set<string>>();
        const slotSummaries = instance.slots.map(slot => this.summarizeSlot(slot, classifierMatches));
        const parsedName = parseInstanceName(instance.name);

        const directClassifier = instance.classifier?.ref;
        let resolvedClassifier: ClassifierInfo | undefined;
        if (directClassifier && isSupportedClassifier(directClassifier)) {
            resolvedClassifier = classifiersById.get(directClassifier.__id);
        }

        if (!resolvedClassifier) {
            resolvedClassifier = resolveClassifierFromSlots(classifierMatches, classifiersById);
            const nameMatches = parsedName.classifierName ? classifiersByName.get(parsedName.classifierName.toLowerCase()) ?? [] : [];
            const nameClassifier = nameMatches.length === 1 ? nameMatches[0] : undefined;

            if (!resolvedClassifier && nameClassifier) {
                resolvedClassifier = nameClassifier;
            } else if (resolvedClassifier && nameClassifier && resolvedClassifier.classifier.__id !== nameClassifier.classifier.__id) {
                diagnostics.push({
                    severity: 'warning',
                    message: `Name suggests ${nameClassifier.classifier.name}, but slots resolve to ${resolvedClassifier.classifier.name}.`
                });
            } else if (!resolvedClassifier && nameMatches.length > 1 && parsedName.classifierName) {
                diagnostics.push({
                    severity: 'warning',
                    message: `Multiple classifiers named ${parsedName.classifierName} exist, so the instance cannot be grouped confidently.`
                });
            }

            if (!resolvedClassifier && classifierMatches.size > 1) {
                diagnostics.push({
                    severity: 'warning',
                    message: `Slots reference multiple classifiers (${Array.from(classifierMatches.keys())
                        .map(id => classifiersById.get(id)?.classifier.name ?? id)
                        .join(', ')}).`
                });
            }

            if (!resolvedClassifier && slotSummaries.length === 0 && !parsedName.classifierName) {
                diagnostics.push({
                    severity: 'warning',
                    message: 'No classifier information could be inferred from slots or from the instance name.'
                });
            }
        }

        if (resolvedClassifier) {
            const matchedProperties = classifierMatches.get(resolvedClassifier.classifier.__id) ?? new Set<string>();
            const missingProperties = resolvedClassifier.classifier.properties.filter(property => !matchedProperties.has(property.__id));

            if (missingProperties.length > 0) {
                diagnostics.push({
                    severity: 'warning',
                    message: `Missing slots for classifier properties: ${missingProperties.map(property => property.name).join(', ')}.`
                });
            }

            for (const slotSummary of slotSummaries) {
                const slot = this.modelState.index.findSemanticElement(slotSummary.id, isSlot);
                const definingFeature = slot?.definingFeature?.ref;
                if (isProperty(definingFeature)) {
                    const owner = owningClassifier(definingFeature);
                    if (owner && owner.__id !== resolvedClassifier.classifier.__id) {
                        slotSummary.diagnostics.push({
                            severity: 'warning',
                            message: `Slot belongs to ${owner.name}, not to ${resolvedClassifier.classifier.name}.`
                        });
                    }
                }
            }
        }

        return {
            id: instance.__id,
            name: parsedName.instanceName || instance.name,
            classifierId: resolvedClassifier?.classifier.__id,
            classifierName: resolvedClassifier?.classifier.name,
            slots: slotSummaries.sort((left, right) => left.featureName.localeCompare(right.featureName)),
            diagnostics
        };
    }

    protected summarizeSlot(slot: Slot, classifierMatches: Map<string, Set<string>>): SlotSummary {
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
            const owner = owningClassifier(feature);
            if (owner) {
                const matchedProperties = classifierMatches.get(owner.__id) ?? new Set<string>();
                matchedProperties.add(feature.__id);
                classifierMatches.set(owner.__id, matchedProperties);
            } else {
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
            classifierMatches.set(feature.__id, classifierMatches.get(feature.__id) ?? new Set<string>());
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
        const width = Math.max(170, classifier.name.length * 10 + 48);
        const height = Math.max(60, 34 + classifier.properties.length * 22);
        const x = (classifierPosition?.x ?? 0) + (classifierSize?.width ?? 120) + 48;
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

function resolveClassifierFromSlots(
    classifierMatches: Map<string, Set<string>>,
    classifiersById: Map<string, ClassifierInfo>
): ClassifierInfo | undefined {
    if (classifierMatches.size !== 1) {
        return undefined;
    }

    const classifierId = Array.from(classifierMatches.keys())[0];
    return classifiersById.get(classifierId);
}

function parseInstanceName(name: string): { instanceName: string; classifierName?: string } {
    const match = name.match(/^\s*(.*?)\s*:\s*(.+?)\s*$/);
    if (!match) {
        return { instanceName: name };
    }

    return {
        instanceName: match[1] || name,
        classifierName: match[2]
    };
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
