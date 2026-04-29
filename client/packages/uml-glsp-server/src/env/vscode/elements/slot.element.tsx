/********************************************************************************
 * Copyright (c) 2022-2023 STMicroelectronics and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import { ClassDiagramNodeTypes, CommonModelTypes } from '@borkdominik-biguml/uml-glsp-server';
import { GLabelElement } from '@borkdominik-biguml/uml-glsp-server/jsx';
import type { Slot } from '@borkdominik-biguml/uml-model-server/grammar';
import { GNode, type GModelElement } from '@eclipse-glsp/server';

export class GSlotNode extends GNode {
    override type = ClassDiagramNodeTypes.SLOT;
    override layout = 'hbox';
}

export interface GSlotNodeElementProps {
    node: Slot;
}

export function GSlotNodeElement(props: GSlotNodeElementProps): GModelElement {
    const { node } = props;
    const id = node.__id;

    const slotNode = new GSlotNode();
    slotNode.id = id;
    slotNode.layoutOptions = { resizeContainer: true, hGap: 3 };
    slotNode.args = { build_by: 'dave' };
    slotNode.cssClasses = [];
    slotNode.children = [];

    const propertyName = node.definingFeature?.ref?.name ?? node.name ?? '';
    const joinedValues = node.values?.map(value => value.value ?? value.name ?? '').filter(v => v.length > 0).join(', ') ?? '';
    const slotText = joinedValues.length > 0 ? `${propertyName} = ${joinedValues}` : propertyName;

    const slotLabel = <GLabelElement type={CommonModelTypes.LABEL_TEXT} text={slotText} />;
    slotLabel.parent = slotNode;
    slotNode.children.push(slotLabel);

    return slotNode;
}
