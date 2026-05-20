/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/

import { DiagramModelState } from '@borkdominik-biguml/uml-glsp-server/vscode';
import {
    isClass,
    isDataType,
    isInstanceLink,
    isInstanceSpecification,
    isInterface
} from '@borkdominik-biguml/uml-model-server/grammar';
import { type ActionHandler, type MaybePromise } from '@eclipse-glsp/server';
import { Eta } from 'eta';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { injectable, inject } from 'inversify';
import { streamAst } from 'langium';
import { ExportInstancesResponse, RequestExportInstancesAction, type ExportScope } from '../common/index.js';

interface ExportInstance {
    id: string;
    name: string;
    classifierName: string;
    classifierId?: string;
    slots: { featureName: string; value: string; values: string[] }[];
}

interface ExportClassifier {
    id: string;
    name: string;
}

interface ExportLink {
    id: string;
    relationName?: string;
    sourceInstanceId?: string;
    targetInstanceId?: string;
}

interface ExportContext {
    instances: ExportInstance[];
    classifiers: ExportClassifier[];
    links: ExportLink[];
    diagramName: string;
    timestamp: string;
}

@injectable()
export class ExportInstancesActionHandler implements ActionHandler {
    actionKinds = [RequestExportInstancesAction.KIND];

    @inject(DiagramModelState)
    protected readonly modelState: DiagramModelState;

    execute(action: RequestExportInstancesAction): MaybePromise<any[]> {
        try {
            const scope: ExportScope = action.action.scope;
            const classifiers = this.collectClassifiers();
            const allInstances = this.collectInstances();
            const requestedClassifierIds = new Set(action.action.classifierIds ?? []);

            if (action.action.classifierId) {
                requestedClassifierIds.add(action.action.classifierId);
            }

            let selectedInstances = allInstances;
            if (scope === 'byClassifier' && requestedClassifierIds.size > 0) {
                selectedInstances = allInstances.filter(instance => instance.classifierId && requestedClassifierIds.has(instance.classifierId));
            } else if (scope === 'selection' && Array.isArray(action.action.selection) && action.action.selection.length > 0) {
                const selectedIds = new Set(action.action.selection);
                selectedInstances = allInstances.filter(instance => selectedIds.has(instance.id));
            }

            const selectedInstanceIds = new Set(selectedInstances.map(instance => instance.id));
            const context: ExportContext = {
                instances: selectedInstances.map(instance => ({
                    id: instance.id,
                    name: instance.name,
                    classifierName: instance.classifierName,
                    classifierId: instance.classifierId,
                    slots: instance.slots.map(slot => ({
                        featureName: slot.featureName,
                        value: slot.value,
                        values: [...slot.values]
                    }))
                })),
                classifiers: Array.from(classifiers.values()).map(entry => ({
                    id: entry.classifier.__id,
                    name: entry.classifier.name
                })),
                links: this.collectLinks(selectedInstanceIds),
                diagramName: this.resolveDiagramName(),
                timestamp: new Date().toISOString()
            };

            const templatePath = this.resolveTemplatePath(action.action.templateName || 'json', action.action.customTemplateFile);
            const templateString = readFileSync(templatePath, { encoding: 'utf8' });
            const rendered = new Eta({ autoEscape: false }).renderString(templateString, context) ?? '';

            return [ExportInstancesResponse.create({ success: true, content: rendered })];
        } catch (error: any) {
            return [ExportInstancesResponse.create({ success: false, message: error?.message ?? String(error) })];
        }
    }

    protected collectClassifiers() {
        const byId = new Map<string, any>();
        for (const node of streamAst(this.modelState.semanticRoot)) {
            if (isClass(node) || isInterface(node) || isDataType(node)) {
                byId.set(node.__id, { classifier: node });
            }
        }
        return byId;
    }

    protected collectInstances(): ExportInstance[] {
        const result: ExportInstance[] = [];
        for (const node of streamAst(this.modelState.semanticRoot)) {
            if (!isInstanceSpecification(node)) {
                continue;
            }

            const instance = node;
            const classifierRef = instance.classifier?.ref as any;
            result.push({
                id: instance.__id,
                name: instance.name,
                classifierId: classifierRef?.__id,
                classifierName: classifierRef?.name ?? classifierRef?.$refText ?? '',
                slots: (instance.slots ?? []).map(slot => {
                    const values = (slot.values ?? []).map(value => value.value ?? value.name ?? '');
                    return {
                        featureName: slot.name ?? '',
                        value: values.join(','),
                        values
                    };
                })
            });
        }
        return result;
    }

    protected collectLinks(selectedInstanceIds: Set<string>): ExportLink[] {
        const links: ExportLink[] = [];
        for (const node of streamAst(this.modelState.semanticRoot)) {
            if (!isInstanceLink(node)) {
                continue;
            }

            const sourceInstanceId = node.source?.ref?.__id;
            const targetInstanceId = node.target?.ref?.__id;
            if (!sourceInstanceId || !targetInstanceId) {
                continue;
            }

            if (selectedInstanceIds.size > 0 && (!selectedInstanceIds.has(sourceInstanceId) || !selectedInstanceIds.has(targetInstanceId))) {
                continue;
            }

            links.push({
                id: node.__id,
                relationName: node.name,
                sourceInstanceId,
                targetInstanceId
            });
        }
        return links;
    }

    protected resolveDiagramName(): string {
        const namedDiagram = (this.modelState.semanticRoot as any)?.name;
        if (typeof namedDiagram === 'string' && namedDiagram.trim().length > 0) {
            return namedDiagram;
        }

        return this.modelState.semanticUri ? basename(this.modelState.semanticUri) : 'diagram';
    }

    protected resolveTemplatePath(templateName: string, customTemplateFile?: string | null): string {
        if (customTemplateFile) {
            return customTemplateFile;
        }

        const fileName = `${templateName}.eta`;
        const templatePath = this.resolvePackageTemplatePath(fileName);
        if (!templatePath) {
            throw new Error(`Template "${templateName}" could not be found.`);
        }

        return templatePath;
    }

    protected resolvePackageTemplatePath(fileName: string): string | null {
        try {
            const require = createRequire(__filename);
            const packageEntry = require.resolve('@borkdominik-biguml/big-instance-explorer');

            let currentDir = dirname(packageEntry);
            for (let i = 0; i < 6; i++) {
                const templatePath = join(currentDir, 'templates', fileName);
                if (existsSync(templatePath)) {
                    return templatePath;
                }

                const parentDir = dirname(currentDir);
                if (parentDir === currentDir) {
                    break;
                }

                currentDir = parentDir;
            }

            return null;
        } catch {
            return null;
        }
    }
}
