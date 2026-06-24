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
import { PatternStrategy } from '../src/env/glsp-server/strategies/pattern.strategy.js';
import { createRng } from '../src/env/glsp-server/strategies/rng.js';
import { type PropertyDescriptor, type ValueContext, type ValueStrategy } from '../src/env/glsp-server/strategies/strategy.js';

function ctx(seed: number, index = 1): ValueContext {
    return { rng: createRng(seed), index };
}

function prop(name: string, over: Partial<PropertyDescriptor> = {}): PropertyDescriptor {
    return { name, typeKind: 'string', ...over };
}

describe('PatternStrategy', () => {
    it('declares its kind', () => {
        assert.equal(new PatternStrategy({ patterns: {} }).kind, 'pattern');
    });

    it('substitutes {n} with the 1-based instance index', () => {
        const strategy = new PatternStrategy({ patterns: { name: 'User_{n}' } });
        assert.equal(strategy.value(prop('name'), ctx(1, 3)), 'User_3');
    });

    it('substitutes a placeholder embedded in literal text', () => {
        const strategy = new PatternStrategy({ patterns: { email: 'acc{n}@example.org' } });
        assert.equal(strategy.value(prop('email'), ctx(1, 2)), 'acc2@example.org');
    });

    it('passes through a pattern with no placeholders verbatim', () => {
        const strategy = new PatternStrategy({ patterns: { role: 'admin' } });
        assert.equal(strategy.value(prop('role'), ctx(1)), 'admin');
    });

    it('{pick:...} chooses one of the listed options', () => {
        const options = ['admin', 'user', 'guest'];
        const strategy = new PatternStrategy({ patterns: { role: '{pick:admin,user,guest}' } });
        const value = strategy.value(prop('role'), ctx(7));
        assert.ok(value !== undefined && options.includes(value), `got ${value}`);
    });

    it('trims whitespace around {pick:...} options', () => {
        const strategy = new PatternStrategy({ patterns: { role: '{pick: a , b , c }' } });
        const value = strategy.value(prop('role'), ctx(7));
        assert.ok(value !== undefined && ['a', 'b', 'c'].includes(value), `got ${value}`);
    });

    it('combines {n} and {pick:...} in one pattern', () => {
        const strategy = new PatternStrategy({ patterns: { label: 'r{n}-{pick:x,y}' } });
        const value = strategy.value(prop('label'), ctx(3, 5));
        assert.ok(value !== undefined && /^r5-(x|y)$/.test(value), `got ${value}`);
    });

    it('falls back to the injected fallback strategy for unmapped properties', () => {
        const sentinel: ValueStrategy = { kind: 'stub', value: () => 'FALLBACK' };
        const strategy = new PatternStrategy({ patterns: { name: 'X' } }, sentinel);
        assert.equal(strategy.value(prop('age', { typeKind: 'integer' }), ctx(1)), 'FALLBACK');
    });

    it('defaults to the random strategy as fallback when none is injected', () => {
        const strategy = new PatternStrategy({ patterns: {} });
        const value = strategy.value(prop('age', { typeKind: 'integer' }), ctx(1));
        const n = Number(value);
        assert.ok(Number.isInteger(n) && n >= 0 && n <= 100, `got ${value}`);
    });

    it('is deterministic for the same seed, property and index', () => {
        const strategy = new PatternStrategy({ patterns: { role: '{pick:a,b,c,d,e}' } });
        assert.equal(strategy.value(prop('role'), ctx(42, 1)), strategy.value(prop('role'), ctx(42, 1)));
    });
});
