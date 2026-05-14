/**
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 */

/**
 * Export actions for instance export via templates
 */
import { Action, RequestAction, type ResponseAction } from '@eclipse-glsp/protocol';

export type ExportScope = 'all' | 'byClassifier' | 'selection';

export interface RequestExportInstancesAction extends RequestAction<ExportInstancesResponse> {
    kind: typeof RequestExportInstancesAction.KIND;
    action: {
        scope: ExportScope;
        classifierId?: string | null;
        selection?: string[] | null;
        templateName: string; // e.g. 'json' or custom name
        customTemplateFile?: string | null; // absolute path if provided
    };
}

export namespace RequestExportInstancesAction {
    export const KIND = 'requestExportInstances';

    export function is(object: unknown): object is RequestExportInstancesAction {
        return RequestAction.hasKind(object, KIND);
    }

    export function create(options: Partial<RequestExportInstancesAction> & { action: RequestExportInstancesAction['action'] }): RequestExportInstancesAction {
        return {
            kind: KIND,
            requestId: options.requestId ?? '',
            action: options.action
        } as RequestExportInstancesAction;
    }
}

export interface ExportInstancesResponse extends ResponseAction {
    kind: typeof ExportInstancesResponse.KIND;
    success: boolean;
    message?: string;
    content?: string; // rendered output
}

export namespace ExportInstancesResponse {
    export const KIND = 'exportInstancesResponse';

    export function is(object: unknown): object is ExportInstancesResponse {
        return Action.hasKind(object, KIND);
    }

    export function create(options?: Omit<ExportInstancesResponse, 'kind' | 'responseId'> & { responseId?: string }): ExportInstancesResponse {
        return {
            kind: KIND,
            responseId: options?.responseId ?? '',
            success: options?.success ?? false,
            message: options?.message,
            content: options?.content
        } as ExportInstancesResponse;
    }
}
