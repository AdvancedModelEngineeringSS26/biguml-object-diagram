import { v4 as uuidv4 } from 'uuid';
import type { InferredAssociation, InferredClass, ParsedInstanceData } from './types.js';

interface JsonPatchAdd {
    op: 'add';
    path: string;
    value: Record<string, unknown>;
}

export function buildPatches(params: {
    parsed: ParsedInstanceData;
    classes: InferredClass[];
    associations: InferredAssociation[];
    entityPath?: string;
    relationPath?: string;
    metaPath?: string; // Added path for metaInfos
}): JsonPatchAdd[] {
    const { 
        parsed, classes, associations, 
        entityPath = '/diagram/entities', 
        relationPath = '/diagram/relations',
        metaPath = '/metaInfos' 
    } = params;
    
    const patches: JsonPatchAdd[] = [];
    const createId = () => 'id_' + uuidv4().replace(/-/g, '');
    const classIdBy = new Map<string, string>();
    const classPropertyByFeature = new Map<string, Map<string, { id: string; name: string }>>();
    const associationIdByPair = new Map<string, string>();
    const associationNameByPair = new Map<string, string | undefined>();

    // ─── 1. Create Classes + MetaInfos ───
    classes.forEach((cls, index) => {
        const id = createId();
        classIdBy.set(cls.name, id);
        const propertyMap = new Map<string, { id: string; name: string }>();
        const classWidth = 220;
        const classHeight = Math.max(86, 86 + cls.properties.length * 24);

        const classValue = {
            $type: 'Class',
            __type: 'Class',
            __id: id,
            name: cls.name,
            isAbstract: false,
            isActive: false,
            skip: false,
            visibility: 'PUBLIC',
            properties: cls.properties.map(p => {
                const propId = createId();
                const propName = p.name === 'name' ? 'p_name' : p.name;
                propertyMap.set(p.name, { id: propId, name: propName });
                return {
                    $type: 'Property',
                    __type: 'Property',
                    __id: propId,
                    name: propName,
                    isDerived: false,
                    isDerivedUnion: false,
                    isOrdered: false,
                    isReadOnly: false,
                    isStatic: false,
                    isUnique: true,
                    multiplicity: 'one',
                    visibility: 'PUBLIC'
                };
            }),
            operations: [],
        };
        classPropertyByFeature.set(cls.name, propertyMap);

        // Add the Class
        patches.push({ op: 'add', path: `${entityPath}/-`, value: classValue });

        // Add MetaInfos (Position and Size)
        const xPos = 100 + (index * 200);
        patches.push({
            op: 'add', path: `${metaPath}/-`,
            value: {
                $type: 'Position', __type: 'Position', __id: 'pos_' + id,
                x: xPos, y: 100,
                element: { $ref: { __id: id } }
            }
        });
        patches.push({
            op: 'add', path: `${metaPath}/-`,
            value: {
                $type: 'Size', __type: 'Size', __id: 'size_' + id,
                width: classWidth, height: classHeight,
                element: { $ref: { __id: id } }
            }
        });
    });

// ─── 2. Create Associations / Generalizations ───
    associations.forEach(assoc => {
        const sId = classIdBy.get(assoc.sourceTypeName);
        const tId = classIdBy.get(assoc.targetTypeName);

        if (!sId || !tId) return;

        const associationId = createId();
        
        // Define common properties for ALL relations
        const relationBase: any = {
            __id: associationId,
            relationType: assoc.relationType,
            source: createReference('Node', sId),
            target: createReference('Node', tId),
        };

        if (assoc.relationType === 'GENERALIZATION') {
            relationBase.__type = 'Generalization';
            relationBase.$type = 'Generalization'; // Add if your backend needs $type
            relationBase.isSubstitutable = true;
        } else {
            // Logic for ASSOCIATION
            relationBase.__type = 'Association';
            relationBase.$type = 'Association';
            relationBase.sourceAggregation = 'NONE';
            relationBase.targetAggregation = 'NONE';
            relationBase.visibility = 'PUBLIC';
            relationBase.sourceMultiplicity = formatMultiplicity(assoc.sourceMultiplicity);
            relationBase.targetMultiplicity = formatMultiplicity(assoc.targetMultiplicity);
            relationBase.relationType = 'ASSOCIATION';
            
            if (assoc.name && assoc.name.trim().length > 0) {
                relationBase.name = assoc.name;
            }
        }

        patches.push({
            op: 'add',
            path: `${relationPath}/-`,
            value: relationBase
        });
    });


    // ─── 3. Create InstanceSpecifications + MetaInfos ───
    const instanceIdByName = new Map<string, string>();
    let instanceIndex = 0;

    const createSlot = (definingProperty: { id: string; name: string }, name: string, value: string) => {
        return {
            $type: 'Slot',
            __type: 'Slot',
            __id: createId(),
            name: name,
            definingFeature: {
                $ref: { __id: definingProperty.id },
                $refText: definingProperty.name
            },
            values: [
                {
                    $type: 'LiteralSpecification',
                    __type: 'LiteralSpecification',
                    __id: createId(),
                    name: value,
                    value: value
                }
            ]
        };
    };

    parsed.instances.forEach(inst => {
        const classId = classIdBy.get(inst.typeName);
        if (!classId) {
            throw new Error(`Cannot create instance "${inst.name}": no inferred class for type "${inst.typeName}".`);
        }

        const instanceId = createId();
        instanceIdByName.set(inst.name, instanceId);

        const properties = classPropertyByFeature.get(inst.typeName) ?? new Map();
        const usedFeatures = new Set<string>();
        const slots = inst.slots.flatMap(slot => {
            const definingProperty = properties.get(slot.featureName);
            if (!definingProperty) {
                return [];
            }
            usedFeatures.add(slot.featureName);
            return [createSlot(definingProperty, definingProperty.name, normalizeLiteralToken(slot.value))];
        });

        const cls = classes.find(c => c.name === inst.typeName);
        cls?.properties.forEach(p => {
            if (p.isOptional && !usedFeatures.has(p.name)) {
                const definingProperty = properties.get(p.name);
                if (definingProperty) {
                    slots.push(createSlot(definingProperty, '_', '_'));
                }
            }
        });

        patches.push({
            op: 'add',
            path: `${entityPath}/-`,
            value: {
                $type: 'InstanceSpecification',
                __type: 'InstanceSpecification',
                __id: instanceId,
                name: inst.name,
                visibility: 'PUBLIC',
                classifier: {
                    $ref: { __id: classId },
                    $refText: inst.typeName
                },
                slots
            }
        });

        const col = instanceIndex % 4;
        const row = Math.floor(instanceIndex / 4);
        instanceIndex++;
        const width = 160;
        const height = Math.max(70, 40 + slots.length * 20);
        const xPos = 100 + col * 280;
        const yPos = 320 + row * 180;

        patches.push({
            op: 'add',
            path: `${metaPath}/-`,
            value: {
                $type: 'Position',
                __type: 'Position',
                __id: `pos_${instanceId}`,
                x: xPos,
                y: yPos,
                element: { $ref: { __id: instanceId } }
            }
        });
        patches.push({
            op: 'add',
            path: `${metaPath}/-`,
            value: {
                $type: 'Size',
                __type: 'Size',
                __id: `size_${instanceId}`,
                width,
                height,
                element: { $ref: { __id: instanceId } }
            }
        });
    });

    // ─── 4. Create InstanceLinks ───
    parsed.links.forEach(link => {
        const sourceId = instanceIdByName.get(link.sourceName);
        const targetId = instanceIdByName.get(link.targetName);
        if (!sourceId || !targetId) {
            return;
        }

        const sourceType = parsed.instances.find(i => i.name === link.sourceName)?.typeName;
        const targetType = parsed.instances.find(i => i.name === link.targetName)?.typeName;
        const associationKey = sourceType && targetType ? `${sourceType}→${targetType}` : undefined;
        const associationId = associationKey ? associationIdByPair.get(associationKey) : undefined;
        const associationName = associationKey ? associationNameByPair.get(associationKey) : undefined;
        const resolvedLinkName = normalizeLinkName(
            associationName ?? link.linkName ?? `${sourceType ?? link.sourceName}_${targetType ?? link.targetName}`
        );

        patches.push({
            op: 'add',
            path: `${relationPath}/-`,
            value: {
                $type: 'InstanceLink',
                __type: 'InstanceLink',
                __id: createId(),
                name: resolvedLinkName,
                relationType: 'INSTANCE_LINK',
                ...(associationId
                    ? {
                        association: {
                            ...createReference('Association', associationId)
                        }
                    }
                    : {}),
                source: createReference('Node', sourceId),
                target: createReference('Node', targetId)
            }
        });
    });

    return patches;
}

function normalizeLiteralToken(value: string): string {
    const trimmed = value.trim();
    const lower = trimmed.toLowerCase();

    let normalized = trimmed
        .replace(/[\s:]+/g, '_') 
        .replace(/\s+/g, '-')
        .replace(/\./g, '_')
        .replace(/\//g, '-')
        .replace(/[^\w*-]/g, '');

    if (lower === 'true' || lower === 'false') {
        return `b_${lower}`;
    }

    const isDate = /^(\d{4}[-/]\d{2}[-/]\d{2})([-T ]\d{2,}([:]\d{2})?([:]\d{2})?)?$/.test(trimmed);
    if (isDate) {
        normalized = `t_${normalized}`; // Ensure consistent hyphens
    }

    const isNumeric = /^-?\d+(\.\d+)?$/.test(trimmed);

    if (isNumeric && normalized.length > 0 && !normalized.startsWith('n')) {
        normalized = `n_${normalized}`;
    }

    if (/^\d/.test(normalized)) {
        normalized = `_${normalized}`;
    }


    return normalized.length > 0 ? normalized : 'unknown';
}

function normalizeLinkName(value: string): string {
    const trimmed = value.trim();
    const normalized = trimmed
        .replace(/\s+/g, '_')
        .replace(/\./g, '_')
        .replace(/[^\w*-]/g, '');
    return normalized.length > 0 ? normalized : 'link';
}

function createReference(refType: 'Node' | 'Association', id: string): Record<string, unknown> {
    return {
        __type: 'Reference',
        __refType: refType,
        __value: id,
        // Add this so the serializer finds element.source.ref.__id
        ref: {
            __id: id
        }
    };
}


function formatMultiplicity(m?: string): string {
    // Handle null or undefined
    if (!m) return 'one';

    // Clean the string (remove spaces and lowercase it)
    const trimmed = m.trim().toLowerCase();

    // List of values that represent "Many" in UML
    const manyMarkers = ['*', 'many', 'n', '0..*', '1..*', '*..*', '0..n', '1..n'];

    if (manyMarkers.includes(trimmed)) {
        return '*';
    }

    // Default to 'one' for values like '1', '1..1', or empty strings
    return 'one';
}
