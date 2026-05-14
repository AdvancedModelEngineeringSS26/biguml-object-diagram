/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/
import { DiagramModelState } from '@borkdominik-biguml/uml-glsp-server/vscode';
import { isInstanceSpecification, type InstanceSpecification } from '@borkdominik-biguml/uml-model-server/grammar';
import { type ActionHandler, type MaybePromise } from '@eclipse-glsp/server';
import { Eta } from 'eta';
import { readFileSync } from 'fs';
import { inject, injectable } from 'inversify';
import { streamAst } from 'langium';
import { join } from 'path';
import {
    ExportInstancesResponse,
    RequestExportInstancesAction,
    type ExportScope
} from '../common/export.action.js';

interface ExportInstance {
    id: string;
    name: string;
    classifierName?: string;
    classifierId?: string;
    slots: { featureName: string; value: string }[];
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
    diagramName?: string;
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

            let selectedInstances = allInstances;
            if (scope === 'byClassifier' && action.action.classifierId) {
                selectedInstances = allInstances.filter(i => i.classifierId === action.action.classifierId);
            } else if (scope === 'selection' && Array.isArray(action.action.selection) && action.action.selection.length > 0) {
                const set = new Set(action.action.selection);
                selectedInstances = allInstances.filter(i => set.has(i.id));
            }

            const selectedInstanceIds = new Set(selectedInstances.map(instance => instance.id));

            const context: ExportContext = {
                instances: selectedInstances.map(i => ({
                    id: i.id,
                    name: i.name,
                    classifierName: i.classifierName,
                    slots: i.slots.map(s => ({ featureName: s.featureName, value: s.value }))
                })),
                classifiers: Array.from(classifiers.values()).map(c => ({ id: c.classifier.__id, name: c.classifier.name })),
                links: this.collectLinks(selectedInstanceIds),
                diagramName: this.modelState.semanticRoot?.diagram?.__id,
                timestamp: new Date().toISOString()
            };

            const eta = new Eta();
            let templateString: string;
            if (action.action.customTemplateFile) {
                templateString = readFileSync(action.action.customTemplateFile, { encoding: 'utf8' });
            } else {
                const name = action.action.templateName || 'json';
                const templatePath = join(__dirname, '..', '..', 'templates', `${name}.eta`);
                templateString = readFileSync(templatePath, { encoding: 'utf8' });
            }

            const rendered = eta.renderString(templateString, context) ?? '';

            return [ExportInstancesResponse.create({ success: true, content: rendered })];
        } catch (e: any) {
            return [ExportInstancesResponse.create({ success: false, message: e?.message ?? String(e) })];
        }
    }

    protected collectClassifiers() {
        const byId = new Map<string, any>();
        for (const node of streamAst(this.modelState.semanticRoot)) {
            // classifier types are Class, Interface, DataType
            if ((node as any).name && (node as any).__type && ['Class', 'Interface', 'DataType'].includes((node as any).__type)) {
                byId.set((node as any).__id, { classifier: node });
            }
        }
        return byId;
    }

    protected collectInstances() {
        const result: ExportInstance[] = [];
        for (const node of streamAst(this.modelState.semanticRoot)) {
            if (!isInstanceSpecification(node)) continue;
            const inst = node as InstanceSpecification;
            const classifierRef = inst.classifier?.ref as any;
            result.push({
                id: inst.__id,
                name: inst.name,
                classifierId: classifierRef?.__id,
                classifierName: classifierRef?.name ?? classifierRef?.$refText,
                slots: (inst.slots ?? []).map(s => ({ featureName: s.name ?? '', value: (s.values ?? []).map(v => v.value ?? v.name ?? '').join(',') }))
            });
        }
        return result;
    }

    protected collectLinks(selectedInstanceIds: Set<string>) {
        const links: ExportLink[] = [];
        for (const node of streamAst(this.modelState.semanticRoot)) {
            const n: any = node as any;
            if (n.__type && n.__type.toLowerCase().includes('instancelink')) {
                const sourceInstanceId = n.source?.ref?.__id;
                const targetInstanceId = n.target?.ref?.__id;
                if (!sourceInstanceId || !targetInstanceId) {
                    continue;
                }

                if (selectedInstanceIds.size > 0 && (!selectedInstanceIds.has(sourceInstanceId) || !selectedInstanceIds.has(targetInstanceId))) {
                    continue;
                }

                links.push({ id: n.__id, relationName: n.name, sourceInstanceId, targetInstanceId });
            }
        }
        return links;
    }
}
