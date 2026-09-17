import * as pako from "pako";
import { HomeAssistantFixed } from "../types/fixes";
import { CalibrationPoint, MapExtractorRoom } from "../types/types";

/**
 * Types describing Valetudo's "RawMapData" JSON structure (the same JSON that
 * Hypfer/lovelace-valetudo-map-card decodes). Valetudo embeds this JSON,
 * zlib-compressed, inside a PNG "zTXt" text chunk of the image it serves as
 * its camera entity's snapshot. That PNG is what people call the "fake
 * camera" - visually mostly meaningless, it just exists to carry the JSON
 * through Home Assistant's camera entity plumbing.
 */
export interface ValetudoRawMapLayer {
    type: "floor" | "segment" | "wall";
    pixels: number[];
    compressedPixels?: number[];
    metaData: {
        area?: number;
        segmentId?: string;
        name?: string;
        active?: boolean;
    };
    dimensions: {
        x: { min: number; max: number; mid?: number; avg?: number };
        y: { min: number; max: number; mid?: number; avg?: number };
        pixelCount?: number;
    };
}

export interface ValetudoRawMapEntity {
    type:
        | "charger_location"
        | "robot_position"
        | "go_to_target"
        | "path"
        | "predicted_path"
        | "virtual_wall"
        | "no_go_area"
        | "no_mop_area"
        | "active_zone"
        | string;
    points: number[];
    metaData?: { angle?: number };
}

export interface ValetudoRawMapData {
    metaData: { version: number; nonce?: string };
    size: { x: number; y: number };
    pixelSize: number;
    layers: ValetudoRawMapLayer[];
    entities: ValetudoRawMapEntity[];
}

export interface ValetudoRenderOptions {
    floorColor?: string;
    wallColor?: string;
    segmentColors?: string[];
    pathColor?: string;
    robotColor?: string;
    chargerColor?: string;
    goToTargetColor?: string;
    backgroundColor?: string;
    scale?: number;
}

export interface ValetudoRenderResult {
    nonce: string;
    dataUrl: string;
    calibrationPoints: CalibrationPoint[];
    rooms: Record<string, MapExtractorRoom>;
}

const DEFAULT_OPTIONS: Required<ValetudoRenderOptions> = {
    floorColor: "#3C4048",
    wallColor: "#7B90A0",
    segmentColors: ["#19A1A1", "#7AC037", "#DF5618", "#F9A825", "#7D5BA6", "#4285F4", "#E91E63", "#00897B"],
    pathColor: "rgba(255,255,255,0.9)",
    robotColor: "#03A9F4",
    chargerColor: "#4CAF50",
    goToTargetColor: "#2196F3",
    backgroundColor: "#15171B",
    scale: 3,
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/**
 * Extracts zTXt (compressed text) chunks from a PNG file. Valetudo stores
 * its raw map JSON under the "ValetudoMap" keyword.
 */
export function extractCompressedTextChunks(buffer: ArrayBuffer): { keyword: string; data: Uint8Array }[] {
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) {
            throw new Error("Not a valid PNG file - is this entity really a Valetudo map camera?");
        }
    }
    const chunks: { keyword: string; data: Uint8Array }[] = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = readUint32(bytes, offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const dataStart = offset + 8;
        if (type === "IEND") {
            break;
        }
        if (type === "zTXt") {
            const chunkData = bytes.slice(dataStart, dataStart + length);
            let keywordEnd = 0;
            while (keywordEnd < chunkData.length && chunkData[keywordEnd] !== 0) {
                keywordEnd++;
            }
            const keyword = String.fromCharCode(...Array.from(chunkData.slice(0, keywordEnd)));
            // chunkData[keywordEnd] = null separator, chunkData[keywordEnd + 1] = compression method (0 = zlib)
            const compressed = chunkData.slice(keywordEnd + 2);
            chunks.push({ keyword, data: compressed });
        }
        offset = dataStart + length + 4; // + 4 to skip the CRC32 trailer
    }
    return chunks;
}

export function parseValetudoMapFromPng(buffer: ArrayBuffer): ValetudoRawMapData {
    const chunk = extractCompressedTextChunks(buffer).find(c => c.keyword === "ValetudoMap");
    if (!chunk) {
        throw new Error("No embedded Valetudo map data found in camera image");
    }
    const inflated = pako.inflate(chunk.data);
    const json = new TextDecoder("utf-8").decode(inflated);
    const data = JSON.parse(json) as ValetudoRawMapData;
    // Map format v2 may RLE-encode pixel arrays as repeated [xStart, y, count] triples.
    data.layers.forEach(layer => {
        if ((!layer.pixels || layer.pixels.length === 0) && layer.compressedPixels?.length) {
            const pixels: number[] = [];
            for (let i = 0; i < layer.compressedPixels.length; i += 3) {
                const xStart = layer.compressedPixels[i];
                const y = layer.compressedPixels[i + 1];
                const count = layer.compressedPixels[i + 2];
                for (let j = 0; j < count; j++) {
                    pixels.push(xStart + j, y);
                }
            }
            layer.pixels = pixels;
            delete layer.compressedPixels;
        }
    });
    return data;
}

interface BoundingBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

function computeBoundingBox(data: ValetudoRawMapData): BoundingBox {
    const relevant = data.layers.filter(l => l.type === "floor" || l.type === "wall" || l.type === "segment");
    const box: BoundingBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    relevant.forEach(l => {
        box.minX = Math.min(box.minX, l.dimensions.x.min);
        box.minY = Math.min(box.minY, l.dimensions.y.min);
        box.maxX = Math.max(box.maxX, l.dimensions.x.max);
        box.maxY = Math.max(box.maxY, l.dimensions.y.max);
    });
    if (!isFinite(box.minX) || !isFinite(box.minY) || !isFinite(box.maxX) || !isFinite(box.maxY)) {
        return { minX: 0, minY: 0, maxX: data.size.x, maxY: data.size.y };
    }
    return box;
}

function findEntity(data: ValetudoRawMapData, type: string): ValetudoRawMapEntity | undefined {
    return data.entities.find(e => e.type === type);
}

/**
 * Renders a Valetudo RawMapData structure to a canvas (floor/walls/segments
 * as filled pixels, path as a line, robot/charger/go-to as dots) and returns
 * it as a data: URL, along with calibration points computed directly from
 * the map's own pixelSize/bounding box (so no manual calibration is needed)
 * and a `rooms` map compatible with this card's ROOM selection mode.
 */
export function renderValetudoMap(
    data: ValetudoRawMapData,
    options?: ValetudoRenderOptions,
): { dataUrl: string; calibrationPoints: CalibrationPoint[]; rooms: Record<string, MapExtractorRoom> } {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const box = computeBoundingBox(data);
    const padding = 2;
    const gridWidth = box.maxX - box.minX + 1 + padding * 2;
    const gridHeight = box.maxY - box.minY + 1 + padding * 2;
    const offsetX = box.minX - padding;
    const offsetY = box.minY - padding;

    const canvas = document.createElement("canvas");
    canvas.width = gridWidth * opts.scale;
    canvas.height = gridHeight * opts.scale;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = opts.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const paintPixels = (pixels: number[] | undefined, color: string) => {
        if (!pixels || pixels.length === 0) {
            return;
        }
        ctx.fillStyle = color;
        for (let i = 0; i < pixels.length; i += 2) {
            const x = (pixels[i] - offsetX) * opts.scale;
            const y = (pixels[i + 1] - offsetY) * opts.scale;
            ctx.fillRect(x, y, opts.scale, opts.scale);
        }
    };

    data.layers.filter(l => l.type === "floor").forEach(l => paintPixels(l.pixels, opts.floorColor));

    const segments = data.layers.filter(l => l.type === "segment");
    const rooms: Record<string, MapExtractorRoom> = {};
    segments.forEach((l, i) => {
        const color = opts.segmentColors[i % opts.segmentColors.length];
        paintPixels(l.pixels, color);
        const segmentId = l.metaData.segmentId ?? String(i + 1);
        rooms[segmentId] = {
            name: l.metaData.name,
            icon: undefined,
            x: undefined,
            y: undefined,
            x0: l.dimensions.x.min * data.pixelSize,
            y0: l.dimensions.y.min * data.pixelSize,
            x1: l.dimensions.x.max * data.pixelSize,
            y1: l.dimensions.y.max * data.pixelSize,
            outline: undefined,
        };
    });

    data.layers.filter(l => l.type === "wall").forEach(l => paintPixels(l.pixels, opts.wallColor));

    // Grid coordinates are pixelSize mm each; entity point coordinates are already in mm.
    const toGrid = (mmX: number, mmY: number): [number, number] => [
        (mmX / data.pixelSize - offsetX) * opts.scale,
        (mmY / data.pixelSize - offsetY) * opts.scale,
    ];

    ctx.strokeStyle = opts.pathColor;
    ctx.lineWidth = Math.max(1, opts.scale / 2);
    ctx.lineJoin = "round";
    data.entities
        .filter(e => e.type === "path" || e.type === "predicted_path")
        .forEach(path => {
            ctx.beginPath();
            for (let i = 0; i < path.points.length; i += 2) {
                const [x, y] = toGrid(path.points[i], path.points[i + 1]);
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.stroke();
        });

    const drawDot = (entityType: string, color: string, radius: number) => {
        const entity = findEntity(data, entityType);
        if (!entity || entity.points.length < 2) {
            return;
        }
        const [x, y] = toGrid(entity.points[0], entity.points[1]);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, radius * opts.scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
    };
    drawDot("go_to_target", opts.goToTargetColor, 1.5);
    drawDot("charger_location", opts.chargerColor, 1.5);
    drawDot("robot_position", opts.robotColor, 2);

    // Calibration: 3 points, computed directly from pixelSize - no manual entry needed.
    // Grid (canvas, pre-scale) point (gx, gy) <-> vacuum mm point (mmX, mmY):
    //   mmX = (gx + offsetX) * pixelSize ; mmY = (gy + offsetY) * pixelSize
    const gridToMap = (gx: number, gy: number): { x: number; y: number } => ({
        x: gx * opts.scale,
        y: gy * opts.scale,
    });
    const gridToVacuum = (gx: number, gy: number): { x: number; y: number } => ({
        x: (gx + offsetX) * data.pixelSize,
        y: (gy + offsetY) * data.pixelSize,
    });
    const calibrationGridPoints: [number, number][] = [
        [0, 0],
        [gridWidth, 0],
        [0, gridHeight],
    ];
    const calibrationPoints: CalibrationPoint[] = calibrationGridPoints.map(([gx, gy]) => ({
        map: gridToMap(gx, gy),
        vacuum: gridToVacuum(gx, gy),
    }));

    return { dataUrl: canvas.toDataURL("image/png"), calibrationPoints, rooms };
}

/**
 * Fetches a Valetudo camera entity's current snapshot, extracts the
 * embedded map JSON and renders it. This is the same technique used by
 * Hypfer/lovelace-valetudo-map-card - a plain HTTP GET of a small PNG,
 * decoded in the browser. No permanent server-side rendering
 * process/video encoder is involved.
 */
export async function fetchAndRenderValetudoMap(
    hass: HomeAssistantFixed,
    cameraEntityId: string,
    options?: ValetudoRenderOptions,
): Promise<ValetudoRenderResult> {
    const state = hass.states[cameraEntityId];
    if (!state) {
        throw new Error(`Entity not found: ${cameraEntityId}`);
    }
    const picturePath = state.attributes["entity_picture"];
    if (!picturePath) {
        throw new Error(`Entity ${cameraEntityId} has no entity_picture - is it a camera?`);
    }
    const url = hass.hassUrl(picturePath);
    const fetchWithAuth = (hass as unknown as {
        fetchWithAuth?: (path: string, init?: RequestInit) => Promise<Response>;
    }).fetchWithAuth;
    const response = fetchWithAuth ? await fetchWithAuth(url) : await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch camera image: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const mapData = parseValetudoMapFromPng(buffer);
    const rendered = renderValetudoMap(mapData, options);
    return {
        nonce: mapData.metaData?.nonce ?? picturePath,
        ...rendered,
    };
}
