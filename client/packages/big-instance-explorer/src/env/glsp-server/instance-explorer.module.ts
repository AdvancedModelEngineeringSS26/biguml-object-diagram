/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/

import { DiagramFeatureModule } from '@borkdominik-biguml/uml-glsp-server/vscode';
import type { ActionHandlerConstructor, InstanceMultiBinding, OperationHandlerConstructor } from '@eclipse-glsp/server';
import {
    CreateClassifierInstanceOperationHandler,
    RequestInstanceExplorerDataActionHandler,
    UpdateInstanceSlotValuesOperationHandler
} from './instance-explorer.handler.js';

class InstanceExplorerDiagramFeatureModule extends DiagramFeatureModule {
    override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
        binding.add(RequestInstanceExplorerDataActionHandler);
    }

    override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
        binding.add(CreateClassifierInstanceOperationHandler);
        binding.add(UpdateInstanceSlotValuesOperationHandler);
    }
}

export const instanceExplorerGlspModule = new InstanceExplorerDiagramFeatureModule();
