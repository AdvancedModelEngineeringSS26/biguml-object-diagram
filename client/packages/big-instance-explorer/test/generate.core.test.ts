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
import { buildGeneration, type ClassifierView, type PropertyView } from '../src/env/glsp-server/generate.core.js';
import { PatternStrategy } from '../src/env/glsp-server/strategies/pattern.strategy.js';
import { RandomStrategy } from '../src/env/glsp-server/strategies/random.strategy.js';
import { type ValueStrategy } from '../src/env/glsp-server/strategies/strategy.js';

type AnyRecord = Record<string, any>;

/** Deterministic, sequential id factory for assertable output. */
function counter(prefix = 'id'): () => string {
    let n = 0;
    return () => `${prefix}${++n}`;
}

function pv(name: string, over: Partial<PropertyView> = {}): PropertyView {
    return { id: `${name}-pid`, name, typeKind: 'string', documentUri: 'mem://test', ...over };
}

function classifier(over: Partial<ClassifierView> & Pick<ClassifierView, 'name'>): ClassifierView {
    return { id: `${over.name}-cid`, documentUri: 'mem://test', properties: [], ...over };
}

const constStrategy = (value: string | undefined): ValueStrategy => ({ kind: 'const', value: () => value });

function instanceOps(patch: { op: string; path: string; value: unknown }[]): AnyRecord[] {
    return patch.filter(p => p.path === '/diagram/entities/-').map(p => p.value as AnyRecord);
}

describe('buildGeneration', () => {
    it('creates `count` instances per classifier as add ops on /diagram/entities/-', () => {
        const person = classifier({ name: 'Person', properties: [pv('name')] });
        const result = buildGeneration([person], { count: 3, strategy: new RandomStrategy(), seed: 1, idFactory: counter() });
        const ops = instanceOps(result.patch);
        assert.equal(ops.length, 3);
        assert.equal(result.instances.length, 3);
        for (const inst of ops) {
            assert.equal(inst.$type, 'InstanceSpecification');
        }
    });

    it('sets the classifier cross-reference (ref.__id + $refText)', () => {
        const person = classifier({ name: 'Person', properties: [pv('name')] });
        const [inst] = instanceOps(buildGeneration([person], { count: 1, strategy: new RandomStrategy(), idFactory: counter() }).patch);
        assert.equal(inst.classifier.$refText, 'Person');
        assert.equal(inst.classifier.ref.__id, 'Person-cid');
        assert.equal(inst.classifier.ref.__documentUri, 'mem://test');
    });

    it('creates a Slot with one LiteralSpecification value per generated property', () => {
        const person = classifier({ name: 'Person', properties: [pv('name')] });
        const [inst] = instanceOps(buildGeneration([person], { count: 1, strategy: constStrategy('Alice'), idFactory: counter() }).patch);
        assert.equal(inst.slots.length, 1);
        const slot = inst.slots[0];
        assert.equal(slot.$type, 'Slot');
        assert.equal(slot.name, 'name');
        assert.equal(slot.definingFeature.ref.__id, 'name-pid');
        assert.equal(slot.definingFeature.$refText, 'name');
        assert.equal(slot.values.length, 1);
        assert.equal(slot.values[0].$type, 'LiteralSpecification');
        assert.equal(slot.values[0].value, 'Alice');
    });

    it('skips read-only properties (no slot)', () => {
        const person = classifier({
            name: 'Person',
            properties: [pv('name'), pv('id', { typeKind: 'integer', isReadOnly: true })]
        });
        const [inst] = instanceOps(buildGeneration([person], { count: 1, strategy: new RandomStrategy(), idFactory: counter() }).patch);
        assert.deepEqual(inst.slots.map((s: AnyRecord) => s.name), ['name']);
    });

    it('warns when a required property cannot be generated and leaves it empty', () => {
        const person = classifier({ name: 'Person', properties: [pv('ref', { typeKind: 'reference', required: true })] });
        const result = buildGeneration([person], { count: 1, strategy: constStrategy(undefined), idFactory: counter() });
        assert.ok(result.diagnostics.some(d => d.code === 'REQUIRED_PROPERTY_SKIPPED' && d.propertyName === 'ref'));
        assert.equal(instanceOps(result.patch)[0].slots.length, 0);
    });

    it('does not warn when an optional property cannot be generated', () => {
        const person = classifier({ name: 'Person', properties: [pv('ref', { typeKind: 'reference' })] });
        const result = buildGeneration([person], { count: 1, strategy: constStrategy(undefined), idFactory: counter() });
        assert.equal(result.diagnostics.length, 0);
    });

    it('enforces best-effort uniqueness and warns when it cannot satisfy it', () => {
        const tag = classifier({ name: 'Tag', properties: [pv('code', { isUnique: true })] });
        const result = buildGeneration([tag], { count: 3, strategy: constStrategy('X'), uniquenessRetries: 3, idFactory: counter() });
        assert.ok(result.diagnostics.some(d => d.code === 'UNIQUENESS_BEST_EFFORT' && d.propertyName === 'code'));
    });

    it('warns on a value that is not type-compatible with the property (follow-up: type-consistency)', () => {
        const person = classifier({ name: 'Person', properties: [pv('age', { typeKind: 'integer' })] });
        const result = buildGeneration([person], { count: 1, strategy: new PatternStrategy({ patterns: { age: 'not-a-number' } }), idFactory: counter() });
        assert.ok(result.diagnostics.some(d => d.code === 'TYPE_MISMATCH' && d.propertyName === 'age'));
    });

    it('does not warn when a value is type-compatible', () => {
        const person = classifier({ name: 'Person', properties: [pv('age', { typeKind: 'integer' })] });
        const result = buildGeneration([person], { count: 1, strategy: new PatternStrategy({ patterns: { age: '{n}' } }), idFactory: counter() });
        assert.equal(result.diagnostics.filter(d => d.code === 'TYPE_MISMATCH').length, 0);
    });

    it('produces unique ids across instances, slots and literals', () => {
        const person = classifier({ name: 'Person', properties: [pv('a'), pv('b')] });
        const result = buildGeneration([person], { count: 3, strategy: new RandomStrategy(), seed: 5, idFactory: counter() });
        const ids: string[] = [];
        for (const inst of instanceOps(result.patch)) {
            ids.push(inst.__id);
            for (const slot of inst.slots) {
                ids.push(slot.__id);
                for (const v of slot.values) ids.push(v.__id);
            }
        }
        assert.equal(ids.length, new Set(ids).size, 'expected all ids to be unique');
    });

    it('generates unique instance names that avoid reserved names', () => {
        const person = classifier({ name: 'Person' });
        const result = buildGeneration([person], { count: 2, strategy: new RandomStrategy(), reservedNames: ['person_1'], idFactory: counter() });
        assert.deepEqual(result.instances.map(i => i.name), ['person_2', 'person_3']);
    });

    it('is deterministic for the same seed and id factory', () => {
        const person = classifier({ name: 'Person', properties: [pv('name'), pv('age', { typeKind: 'integer' })] });
        const run = (): unknown =>
            buildGeneration([person], { count: 2, strategy: new RandomStrategy(), seed: 42, idFactory: counter() }).patch;
        assert.deepEqual(run(), run());
    });

    it('handles multiple classifiers', () => {
        const person = classifier({ name: 'Person', properties: [pv('name')] });
        const address = classifier({ name: 'Address', properties: [pv('city')] });
        const result = buildGeneration([person, address], { count: 2, strategy: new RandomStrategy(), seed: 1, idFactory: counter() });
        assert.equal(result.instances.length, 4);
        assert.equal(result.instances.filter(i => i.classifierName === 'Person').length, 2);
        assert.equal(result.instances.filter(i => i.classifierName === 'Address').length, 2);
    });
});
