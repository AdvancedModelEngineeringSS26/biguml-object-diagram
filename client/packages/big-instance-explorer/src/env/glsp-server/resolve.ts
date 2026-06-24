/**********************************************************************************
 * Copyright (c) 2026 borkdominik and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available at https://opensource.org/licenses/MIT.
 *
 * SPDX-License-Identifier: MIT
 **********************************************************************************/
import { type PropertyTypeKind } from './strategies/strategy.js';

/**
 * Pure helpers that translate raw UML metamodel facts (multiplicity strings,
 * type names) into the plain-data shapes the generation core consumes. Kept
 * separate from the GLSP handler so they can be unit-tested without the AST.
 */

/** Parsed multiplicity bounds. `upper === undefined` means unbounded (`*`). */
export interface MultiplicityBounds {
    lower: number;
    upper?: number;
}

/**
 * Parses a UML multiplicity string. An absent/empty/unparseable multiplicity
 * defaults to required single (`1..1`), matching the UML default of `[1]`.
 */
export function parseMultiplicity(multiplicity: string | undefined): MultiplicityBounds {
    const trimmed = multiplicity?.trim();
    if (!trimmed) {
        return { lower: 1, upper: 1 };
    }
    if (trimmed === '*') {
        return { lower: 0, upper: undefined };
    }
    // Some models use textual multiplicities instead of numeric ones.
    switch (trimmed.toLowerCase()) {
        case 'one':
            return { lower: 1, upper: 1 };
        case 'many':
        case 'zeroormany':
            return { lower: 0, upper: undefined };
        case 'oneormany':
            return { lower: 1, upper: undefined };
        case 'optional':
        case 'zeroorone':
            return { lower: 0, upper: 1 };
        default:
            break;
    }
    if (/^\d+$/.test(trimmed)) {
        const exact = Number(trimmed);
        return { lower: exact, upper: exact };
    }
    const range = trimmed.match(/^(\d+)\s*\.\.\s*(\d+|\*)$/);
    if (range) {
        const lower = Number(range[1]);
        const upper = range[2] === '*' ? undefined : Number(range[2]);
        return { lower, upper };
    }
    return { lower: 1, upper: 1 };
}

/**
 * Classifies a property's type for value generation. Enumerations are detected
 * by the caller (via the AST) and signalled through `isEnumeration`; primitive
 * names are matched case-insensitively; any other named type is a `reference`
 * (handled by link generation, not slot values); no type is `unknown`.
 */
export function toPropertyTypeKind(typeName: string | undefined, isEnumeration = false): PropertyTypeKind {
    if (isEnumeration) {
        return 'enumeration';
    }
    if (typeName === undefined) {
        return 'unknown';
    }
    switch (typeName.trim().toLowerCase()) {
        case 'string':
            return 'string';
        case 'integer':
        case 'int':
            return 'integer';
        case 'boolean':
        case 'bool':
            return 'boolean';
        case 'real':
        case 'float':
        case 'double':
            return 'real';
        default:
            return 'reference';
    }
}
