// The `cmap` table stores the mappings from characters to glyphs.
// https://www.microsoft.com/typography/OTSPEC/cmap.htm

'use strict';

var check = require('../check');
var parse = require('../parse');
var table = require('../table');

function parseCmapTableFormat12(cmap, p) {
    var i;

    //Skip reserved.
    p.parseUShort();

    // Length in bytes of the sub-tables.
    cmap.length = p.parseULong();
    cmap.language = p.parseULong();

    var groupCount;
    cmap.groupCount = groupCount = p.parseULong();
    var glyphIndexMap = {};

    for (i = 0; i < groupCount; i += 1) {
        var startCharCode = p.parseULong();
        var endCharCode = p.parseULong();
        var startGlyphId = p.parseULong();

        for (var c = startCharCode; c <= endCharCode; c += 1) {
            glyphIndexMap = cmap.glyphIndexMap[c] = startGlyphId;
            startGlyphId++;
        }
    }
    return glyphIndexMap;
}

function parseCmapTableFormat4(cmap, p, data, start, offset) {
    var i;

    // Length in bytes of the sub-tables.
    cmap.length = p.parseUShort();
    cmap.language = p.parseUShort();

    // segCount is stored x 2.
    var segCount;
    cmap.segCount = segCount = p.parseUShort() >> 1;

    // Skip searchRange, entrySelector, rangeShift.
    p.skip('uShort', 3);

    // The "unrolled" mapping from character codes to glyph indices.
    var glyphIndexMap = {};
    var endCountParser = new parse.Parser(data, start + offset + 14);
    var startCountParser = new parse.Parser(data, start + offset + 16 + segCount * 2);
    var idDeltaParser = new parse.Parser(data, start + offset + 16 + segCount * 4);
    var idRangeOffsetParser = new parse.Parser(data, start + offset + 16 + segCount * 6);
    var glyphIndexOffset = start + offset + 16 + segCount * 8;
    for (i = 0; i < segCount - 1; i += 1) {
        var glyphIndex;
        var endCount = endCountParser.parseUShort();
        var startCount = startCountParser.parseUShort();
        var idDelta = idDeltaParser.parseShort();
        var idRangeOffset = idRangeOffsetParser.parseUShort();
        for (var c = startCount; c <= endCount; c += 1) {
            if (idRangeOffset !== 0) {
                // The idRangeOffset is relative to the current position in the idRangeOffset array.
                // Take the current offset in the idRangeOffset array.
                glyphIndexOffset = (idRangeOffsetParser.offset + idRangeOffsetParser.relativeOffset - 2);

                // Add the value of the idRangeOffset, which will move us into the glyphIndex array.
                glyphIndexOffset += idRangeOffset;

                // Then add the character index of the current segment, multiplied by 2 for USHORTs.
                glyphIndexOffset += (c - startCount) * 2;
                glyphIndex = parse.getUShort(data, glyphIndexOffset);
                if (glyphIndex !== 0) {
                    glyphIndex = (glyphIndex + idDelta) & 0xFFFF;
                }
            } else {
                glyphIndex = (c + idDelta) & 0xFFFF;
            }

            glyphIndexMap[c] = cmap.glyphIndexMap[c] = glyphIndex;
        }
    }
    return glyphIndexMap;
}

function parseCmapTableFormat14(cmap, p) {
    var i;
    var j;
    var k;

    // Length in bytes of the sub-tables.
    cmap.uvsLength = p.parseULong();

    // Number of variation selector records in this sub-tables.
    var numVarSelectorRecords;
    cmap.numVarSelectorRecords = numVarSelectorRecords = p.parseULong();

    var uvsGlyphMap = cmap.uvsGlyphMap = {};

    var uvsTables = [];
    for (i = 0; i < numVarSelectorRecords; i += 1) {
        var varSelector = p.parseUint24();	// uint24
        var defaultUVSOffset = p.parseULong();  // Offset32
        var nonDefaultUVSOffset = p.parseULong(); // Offset32

        uvsTables.push({
            varSelector: varSelector,
            defaultUVSOffset: defaultUVSOffset,
            nonDefaultUVSOffset: nonDefaultUVSOffset
        });
    }

    uvsTables.forEach(function(uvsTable) {
        uvsGlyphMap[uvsTable.varSelector] = {};

        /* Default UVS Table */
        if (uvsTable.defaultUVSOffset !== 0)
        {
            // UnicodeRane Array
            // numUnicodeValueRanges: uint32
            var numUnicodeValueRanges = p.parseULong();

            for (j = 0; j < numUnicodeValueRanges; j += 1) {
                // startUnicodeVelue: uint24
                var startUnicodeValue = p.parseUint24();
                // additionalCount: uint8
                var additionalCount = p.parseByte();

                for (k = 0; k < additionalCount + 1; k += 1) {
                    uvsGlyphMap[uvsTable.varSelector][startUnicodeValue += k] = 'Default';
                }
            }
        }
        /* Non-Default UVS Table */
        if (uvsTable.nonDefaultUVSOffset !== 0)
        {
            // numUVSMappings: uint32
            var numUVSMappings = p.parseULong();
            // UVSMapping
            for (j = 0; j < numUVSMappings; j += 1) {
                // startUnicodeVelue: uint24
                var unicodeValue = p.parseUint24();
                // additionalCount: uint8
                var glyphID = p.parseUShort();

                uvsGlyphMap[uvsTable.varSelector][unicodeValue] = glyphID;
            }
        }
    });

    return uvsGlyphMap;
}

// Parse the `cmap` table. This table stores the mappings from characters to glyphs.
// There are many available formats, but we only support the Windows format 4 and 12.
// This function returns a `CmapEncoding` object or null if no supported format could be found.
function parseCmapTable(data, start) {
    var i;
    var cmap = {};
    var offset = -1;
    var uvsOffset = -1;
    var p;
    var format;

    cmap.version = parse.getUShort(data, start);
    check.argument(cmap.version === 0, 'cmap table version should be 0.');

    // The cmap table can contain many sub-tables, each with their own format.
    // We're only interested in a "platform 3" table. This is a Windows format.
    cmap.numTables = parse.getUShort(data, start + 2);
    cmap.tables = [];
    cmap.glyphIndexMap = {};

    for (i = cmap.numTables - 1; i >= 0; i -= 1) {
        var platformId = parse.getUShort(data, start + 4 + (i * 8));
        var encodingId = parse.getUShort(data, start + 4 + (i * 8) + 2);

        // cmap format 14
        if (platformId === 0 && encodingId === 5) {
            uvsOffset = parse.getULong(data, start + 4 + (i * 8) + 4);
            p = new parse.Parser(data, start + uvsOffset);
            format = p.parseUShort();
            if (format === 14) {
                cmap.tables.push({
                    format: format,
                    platformId: platformId,
                    encodingId: encodingId,
                    uvsGlyphMap: parseCmapTableFormat14(cmap, p)
                });

            }
        }

        if (platformId === 3 && (encodingId === 0 || encodingId === 1 || encodingId === 10)) {
            offset = parse.getULong(data, start + 4 + (i * 8) + 4);
            p = new parse.Parser(data, start + offset);
            format = p.parseUShort();
            if (format === 12) {
                cmap.tables.push({
                    format: format,
                    platformId: platformId,
                    encodingId: encodingId,
                    glyphIndexMap: parseCmapTableFormat12(cmap, p)
                });
            } else if (format === 4) {
                cmap.tables.push({
                    format: format,
                    platformId: platformId,
                    encodingId: encodingId,
                    glyphIndexMap: parseCmapTableFormat4(cmap, p, data, start, offset)
                });
            } else {
                throw new Error('Only format 4 and 12 cmap tables are supported.');
            }
        }
    }

    if (offset === -1) {
        // There is no cmap table in the font that we support, so return null.
        // This font will be marked as unsupported.
        return null;
    }

    return cmap;
}

function addSegment(t, code, glyphIndex) {
    t.segments.push({
        end: code,
        start: code,
        delta: -(code - glyphIndex),
        offset: 0
    });
}

function addTerminatorSegment(t) {
    t.segments.push({
        end: 0xFFFF,
        start: 0xFFFF,
        delta: 1,
        offset: 0
    });
}

function makeCmapTable(glyphs) {
    var i;
    var t = new table.Table('cmap', [
        {name: 'version', type: 'USHORT', value: 0},
        {name: 'numTables', type: 'USHORT', value: 1},
        {name: 'platformID', type: 'USHORT', value: 3},
        {name: 'encodingID', type: 'USHORT', value: 1},
        {name: 'offset', type: 'ULONG', value: 12},
        {name: 'format', type: 'USHORT', value: 4},
        {name: 'length', type: 'USHORT', value: 0},
        {name: 'language', type: 'USHORT', value: 0},
        {name: 'segCountX2', type: 'USHORT', value: 0},
        {name: 'searchRange', type: 'USHORT', value: 0},
        {name: 'entrySelector', type: 'USHORT', value: 0},
        {name: 'rangeShift', type: 'USHORT', value: 0}
    ]);

    t.segments = [];
    for (i = 0; i < glyphs.length; i += 1) {
        var glyph = glyphs.get(i);
        for (var j = 0; j < glyph.unicodes.length; j += 1) {
            addSegment(t, glyph.unicodes[j], i);
        }

        t.segments = t.segments.sort(function(a, b) {
            return a.start - b.start;
        });
    }

    addTerminatorSegment(t);

    var segCount;
    segCount = t.segments.length;
    t.segCountX2 = segCount * 2;
    t.searchRange = Math.pow(2, Math.floor(Math.log(segCount) / Math.log(2))) * 2;
    t.entrySelector = Math.log(t.searchRange / 2) / Math.log(2);
    t.rangeShift = t.segCountX2 - t.searchRange;

    // Set up parallel segment arrays.
    var endCounts = [];
    var startCounts = [];
    var idDeltas = [];
    var idRangeOffsets = [];
    var glyphIds = [];

    for (i = 0; i < segCount; i += 1) {
        var segment = t.segments[i];
        endCounts = endCounts.concat({name: 'end_' + i, type: 'USHORT', value: segment.end});
        startCounts = startCounts.concat({name: 'start_' + i, type: 'USHORT', value: segment.start});
        idDeltas = idDeltas.concat({name: 'idDelta_' + i, type: 'SHORT', value: segment.delta});
        idRangeOffsets = idRangeOffsets.concat({name: 'idRangeOffset_' + i, type: 'USHORT', value: segment.offset});
        if (segment.glyphId !== undefined) {
            glyphIds = glyphIds.concat({name: 'glyph_' + i, type: 'USHORT', value: segment.glyphId});
        }
    }

    t.fields = t.fields.concat(endCounts);
    t.fields.push({name: 'reservedPad', type: 'USHORT', value: 0});
    t.fields = t.fields.concat(startCounts);
    t.fields = t.fields.concat(idDeltas);
    t.fields = t.fields.concat(idRangeOffsets);
    t.fields = t.fields.concat(glyphIds);

    t.length = 14 + // Subtable header
        endCounts.length * 2 +
        2 + // reservedPad
        startCounts.length * 2 +
        idDeltas.length * 2 +
        idRangeOffsets.length * 2 +
        glyphIds.length * 2;

    return t;
}

exports.parse = parseCmapTable;
exports.make = makeCmapTable;
