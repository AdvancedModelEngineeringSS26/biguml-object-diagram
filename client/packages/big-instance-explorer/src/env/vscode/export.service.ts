/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/

import { TYPES, type ActionDispatcher, type ActionListener, type OnActivate, type OnDispose, type SelectionService } from '@borkdominik-biguml/big-vscode/vscode';
import { DisposableCollection } from '@eclipse-glsp/protocol';
import { inject, injectable } from 'inversify';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import * as vscode from 'vscode';
import {
    AvailableExportTemplatesResponse,
    RequestAvailableExportTemplatesAction,
    RequestSaveExportedInstancesAction,
    SaveExportedInstancesResponse
} from '../common/index.js';
import type { ExportTemplateSummary } from '../common/index.js';

@injectable()
export class InstanceExportService implements OnActivate, OnDispose {
    @inject(TYPES.ExtensionContext)
    protected readonly extensionContext: vscode.ExtensionContext;

    @inject(TYPES.ActionDispatcher)
    protected readonly actionDispatcher: ActionDispatcher;

    @inject(TYPES.ActionListener)
    protected readonly actionListener: ActionListener;

    @inject(TYPES.SelectionService)
    protected readonly selectionService: SelectionService;

    protected readonly toDispose = new DisposableCollection();
    protected readonly onDidRequestOpenExportDialogEmitter = new vscode.EventEmitter<void>();
    readonly onDidRequestOpenExportDialog = this.onDidRequestOpenExportDialogEmitter.event;
    protected pendingOpenDialogRequest = false;

    onActivate(): void {
        this.toDispose.push(
            this.actionListener.handleVSCodeRequest<RequestAvailableExportTemplatesAction>(
                RequestAvailableExportTemplatesAction.KIND,
                async message =>
                    AvailableExportTemplatesResponse.create({
                        responseId: message.action.requestId,
                        templates: await this.listTemplates(),
                        workspaceTemplateDirectory: this.getWorkspaceTemplateDirectory()
                    })
            ),
            this.actionListener.handleVSCodeRequest<RequestSaveExportedInstancesAction>(
                RequestSaveExportedInstancesAction.KIND,
                async message => {
                    try {
                        const target = await this.selectExportTarget(message.action.suggestedFileName);
                        if (!target) {
                            return SaveExportedInstancesResponse.create({
                                responseId: message.action.requestId,
                                success: false,
                                message: 'Export cancelled.'
                            });
                        }

                        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(message.action.content));
                        return SaveExportedInstancesResponse.create({
                            responseId: message.action.requestId,
                            success: true,
                            filePath: target.fsPath
                        });
                    } catch (error: any) {
                        return SaveExportedInstancesResponse.create({
                            responseId: message.action.requestId,
                            success: false,
                            message: error?.message ?? String(error)
                        });
                    }
                }
            )
        );
    }

    dispose(): void {
        this.toDispose.dispose();
    }

    requestOpenExportDialog(): void {
        this.pendingOpenDialogRequest = true;
        this.onDidRequestOpenExportDialogEmitter.fire();
    }

    consumePendingOpenDialogRequest(): boolean {
        const pending = this.pendingOpenDialogRequest;
        this.pendingOpenDialogRequest = false;
        return pending;
    }

    getSelectedElementIds(): string[] {
        return this.selectionService.selection?.selectedElementsIDs ?? [];
    }

    protected async listTemplates(): Promise<ExportTemplateSummary[]> {
        const sources = [
            {
                directory: this.resolveInstalledTemplateDirectory(),
                kind: 'builtin' as const,
                descriptionPrefix: 'Template from templates'
            },
            {
                directory: this.resolvePackageTemplateDirectory(),
                kind: 'builtin' as const,
                descriptionPrefix: `Template from ${join('packages', 'big-instance-explorer', 'templates')}`
            },
            {
                directory: this.getWorkspaceTemplateDirectory(),
                kind: 'workspace' as const,
                descriptionPrefix: `Workspace template from ${join('.biguml', 'templates')}`
            }
        ];

        const templates = new Map<string, ExportTemplateSummary>();

        for (const source of sources) {
            if (!source.directory) {
                continue;
            }

            for (const template of await this.readTemplatesFromDirectory(source.directory, source.kind, source.descriptionPrefix)) {
                templates.set(`${template.kind}:${template.name}`, template);
            }
        }

        return Array.from(templates.values()).sort((left, right) => {
            if (left.kind !== right.kind) {
                return left.kind.localeCompare(right.kind);
            }

            return left.label.localeCompare(right.label);
        });
    }

    protected async readTemplatesFromDirectory(
        directory: string,
        kind: ExportTemplateSummary['kind'],
        descriptionPrefix: string
    ): Promise<ExportTemplateSummary[]> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(directory));
            return entries
                .filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.eta'))
                .map(([name]) => ({
                    name: basename(name, '.eta'),
                    label: basename(name, '.eta'),
                    kind,
                    extension: this.inferExtensionFromTemplate(name),
                    description: `${descriptionPrefix}/${name}.`,
                    file: join(directory, name)
                }));
        } catch {
            return [];
        }
    }

    protected resolveInstalledTemplateDirectory(): string | null {
        const templateDirectory = this.extensionContext.asAbsolutePath('templates');
        return existsSync(templateDirectory) ? templateDirectory : null;
    }

    protected getWorkspaceTemplateDirectory(): string | null {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return null;
        }

        return join(workspaceFolder.uri.fsPath, '.biguml', 'templates');
    }

    protected resolvePackageTemplateDirectory(): string | null {
        try {
            const require = createRequire(import.meta.url);
            const packageJsonPath = require.resolve('@borkdominik-biguml/big-instance-explorer/package.json');
            const packageRoot = dirname(packageJsonPath);
            const templatesDir = join(packageRoot, 'templates');
            return existsSync(templatesDir) ? templatesDir : null;
        } catch {
            return null;
        }
    }

    protected async selectExportTarget(suggestedFileName: string): Promise<vscode.Uri | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const defaultUri = workspaceFolder ? vscode.Uri.file(join(workspaceFolder.uri.fsPath, suggestedFileName)) : undefined;

        return vscode.window.showSaveDialog({
            defaultUri,
            saveLabel: 'Export Instances'
        });
    }

    protected inferExtensionFromTemplate(templateFileName: string): string {
        const withoutEta = basename(templateFileName, '.eta');
        const nestedExtension = extname(withoutEta);
        return nestedExtension ? nestedExtension.slice(1) : 'txt';
    }
}
