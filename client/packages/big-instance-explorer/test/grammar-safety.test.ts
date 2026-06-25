/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// The production id factory used by the GLSP handler (generate.handler.ts).
import { createRandomUUID } from '../../uml-model-server/src/env/langium-connector/util/id-util.js';
import { buildGeneration, type ClassifierView } from '../src/env/glsp-server/generate.core.js';
import { planLinks, type AssociationView, type LinkableInstance } from '../src/env/glsp-server/links.core.js';
import { RandomStrategy } from '../src/env/glsp-server/strategies/random.strategy.js';

/**
 * Regression guard for the bug found during end-to-end verification (2026-06-25):
 * the `.uml` grammar lexes a digit-leading token as `LANGIUM_INT` instead of
 * `LANGIUM_ID`, so any `__id` that starts with a digit breaks parsing on reload.
 * bigUML avoids this by minting ids as `'a' + randomUUID()` (createRandomUUID),
 * which the generation handler uses. These tests pin that contract so nobody
 * swaps the handler back to a raw UUID factory.
 */

/** A generated id must be a valid LANGIUM_ID and must not start with a digit. */
function assertIdSafe(id: string): void {
    assert.match(id, /^[A-Za-z_]/, `id "${id}" is digit-leading and would lex as LANGIUM_INT`);
    assert.doesNotMatch(id, /[\s"{}[\]:,\\]/, `id "${id}" contains a non-LANGIUM_ID character`);
}

describe('grammar safety — generated ids never lex as LANGIUM_INT', () => {
    it('createRandomUUID never produces a digit-leading id', () => {
        for (let i = 0; i < 300; i++) {
            assertIdSafe(createRandomUUID());
        }
    });

    it('all instance/slot/literal ids from buildGeneration are id-safe (with the production factory)', () => {
        const person: ClassifierView = {
            id: createRandomUUID(),
            name: 'Person',
            documentUri: 'mem://test',
            properties: [
                { id: createRandomUUID(), name: 'name', typeKind: 'string', documentUri: 'mem://test', upperBound: 1 },
                { id: createRandomUUID(), name: 'tags', typeKind: 'string', documentUri: 'mem://test', lowerBound: 2, upperBound: 3 }
            ]
        };
        const result = buildGeneration([person], { count: 5, strategy: new RandomStrategy(), seed: 7, idFactory: createRandomUUID });
        const ids: string[] = [];
        for (const op of result.patch) {
            const inst = op.value as Record<string, any>;
            ids.push(inst.__id);
            for (const slot of inst.slots as Record<string, any>[]) {
                ids.push(slot.__id);
                for (const literal of slot.values as Record<string, any>[]) {
                    ids.push(literal.__id);
                }
            }
        }
        assert.ok(ids.length > 0);
        for (const id of ids) {
            assertIdSafe(id);
        }
    });

    it('all link ids from planLinks are id-safe (with the production factory)', () => {
        const instances: LinkableInstance[] = [
            { id: createRandomUUID(), name: 'employee_1', classifierId: 'Employee', documentUri: 'mem://test' },
            { id: createRandomUUID(), name: 'employee_2', classifierId: 'Employee', documentUri: 'mem://test' },
            { id: createRandomUUID(), name: 'company_1', classifierId: 'Company', documentUri: 'mem://test' }
        ];
        const worksFor: AssociationView = {
            id: createRandomUUID(),
            name: 'worksFor',
            documentUri: 'mem://test',
            sourceClassifierId: 'Employee',
            targetClassifierId: 'Company',
            targetLowerBound: 1,
            targetUpperBound: 1
        };
        const result = planLinks(instances, [worksFor], { depth: 1, seed: 3, minPerSource: 1, idFactory: createRandomUUID });
        assert.ok(result.patch.length > 0, 'expected links to be planned');
        for (const op of result.patch) {
            assertIdSafe((op.value as Record<string, any>).__id);
        }
    });
});
