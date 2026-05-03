/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/

import { FeatureModule } from '@eclipse-glsp/client';
import { ExtensionActionKind } from '@eclipse-glsp/vscode-integration-webview/lib/features/default/extension-action-handler.js';
import { InstanceExplorerDataResponse } from '../common/instance-explorer.action.js';

export const instanceExplorerModule = new FeatureModule(bind => {
    bind(ExtensionActionKind).toConstantValue(InstanceExplorerDataResponse.KIND);
});
