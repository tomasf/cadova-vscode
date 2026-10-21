import * as THREE from "three";
import { Earcut } from "three/src/extras/Earcut.js";

/**
 * A part's closed surface, kept as it was read, so a plane can slice it into the filled face a cross
 * section shows where it cuts the part. Like Cadova Viewer's caps, the face is the true section of
 * the solid: a tube's cut is a ring, not a disc.
 *
 * The slice follows the plane around the surface: each triangle the plane crosses adds a segment
 * between the two edges it crosses, and segments meet at the edges triangles share, closing into
 * loops. The largest loop is an outline, which tells which way outlines turn; the loops turning the
 * other way are holes, each in the smallest outline around it.
 */
export class PartSolid {
    private readonly positions: Float32Array;
    private readonly indices: Uint32Array;
    private distances = new Float64Array(0);

    /** Records a part's meshes, before smoothing their normals unshares their vertices. */
    constructor(part: THREE.Object3D) {
        part.updateMatrixWorld(true);
        const vertices: number[] = [];
        const indices: number[] = [];
        const offsets = new Map<THREE.BufferAttribute, number>();
        const point = new THREE.Vector3();
        part.traverse((child) => {
            if (!(child instanceof THREE.Mesh) || !child.geometry.index) return;
            const position = child.geometry.attributes.position as THREE.BufferAttribute;
            // A part's meshes, one per material, share its vertices
            let offset = offsets.get(position);
            if (offset === undefined) {
                offset = vertices.length / 3;
                offsets.set(position, offset);
                for (let i = 0; i < position.count; i++) {
                    point.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld);
                    vertices.push(point.x, point.y, point.z);
                }
            }
            for (const index of child.geometry.index.array) indices.push(index + offset);
        });
        this.positions = new Float32Array(vertices);
        this.indices = new Uint32Array(indices);
    }

    /**
     * The face where the plane through `origin` with `normal` cuts the part, as triangles in world
     * space, or null if the plane misses it.
     */
    section(normal: THREE.Vector3, origin: THREE.Vector3): Float32Array | null {
        const { positions, indices } = this;
        const vertexCount = positions.length / 3;
        if (this.distances.length !== vertexCount) this.distances = new Float64Array(vertexCount);
        const distances = this.distances;
        const offset = normal.dot(origin);
        for (let i = 0; i < vertexCount; i++) {
            distances[i] = positions[i * 3] * normal.x + positions[i * 3 + 1] * normal.y + positions[i * 3 + 2] * normal.z - offset;
        }
        // A vertex on the plane counts as kept, so every edge either crosses it or doesn't
        const cut = (vertex: number) => distances[vertex] > 0;

        // Where the plane crosses an edge, computed from the edge's lower-numbered end so both
        // triangles sharing the edge get the very same point
        const points: number[] = [];
        const pointForEdge = new Map<number, number>();
        const edgePoint = (a: number, b: number): number => {
            const low = Math.min(a, b), high = Math.max(a, b);
            const key = low * vertexCount + high;
            let point = pointForEdge.get(key);
            if (point === undefined) {
                const t = distances[low] / (distances[low] - distances[high]);
                point = points.length / 3;
                for (let axis = 0; axis < 3; axis++) {
                    points.push(positions[low * 3 + axis] + (positions[high * 3 + axis] - positions[low * 3 + axis]) * t);
                }
                pointForEdge.set(key, point);
            }
            return point;
        };

        // Each crossed triangle's segment runs from where its outline enters the cut-away side to
        // where it leaves it, so neighbors' segments join end to start
        const next = new Map<number, number>();
        for (let i = 0; i < indices.length; i += 3) {
            const corners = [indices[i], indices[i + 1], indices[i + 2]];
            const sides = corners.map(cut);
            if (sides[0] === sides[1] && sides[1] === sides[2]) continue;
            let entering = -1, leaving = -1;
            for (let edge = 0; edge < 3; edge++) {
                const a = corners[edge], b = corners[(edge + 1) % 3];
                if (sides[edge] === sides[(edge + 1) % 3]) continue;
                if (sides[edge]) leaving = edgePoint(a, b);
                else entering = edgePoint(a, b);
            }
            if (entering >= 0 && leaving >= 0 && entering !== leaving) next.set(entering, leaving);
        }
        if (next.size === 0) return null;

        // Points in the plane's own 2D coordinates
        const reference = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const u = new THREE.Vector3().crossVectors(reference, normal).normalize();
        const v = new THREE.Vector3().crossVectors(normal, u);
        const flat = (point: number) => new THREE.Vector2(
            points[point * 3] * u.x + points[point * 3 + 1] * u.y + points[point * 3 + 2] * u.z,
            points[point * 3] * v.x + points[point * 3 + 1] * v.y + points[point * 3 + 2] * v.z,
        );

        const loops: { points: number[]; outline: THREE.Vector2[]; area: number }[] = [];
        const visited = new Set<number>();
        for (const start of next.keys()) {
            if (visited.has(start)) continue;
            const loop: number[] = [];
            let point: number | undefined = start;
            while (point !== undefined && !visited.has(point)) {
                visited.add(point);
                loop.push(point);
                point = next.get(point);
            }
            // A loop that doesn't close comes from a surface that isn't closed there; it has no inside
            if (point !== start || loop.length < 3) continue;
            const outline = loop.map(flat);
            loops.push({ points: loop, outline, area: THREE.ShapeUtils.area(outline) });
        }
        if (loops.length === 0) return null;

        const largest = loops.reduce((a, b) => Math.abs(b.area) > Math.abs(a.area) ? b : a);
        const outlines = loops.filter((loop) => Math.sign(loop.area) === Math.sign(largest.area));
        const holes = loops.filter((loop) => Math.sign(loop.area) !== Math.sign(largest.area));
        const holesOf = new Map(outlines.map((outline) => [outline, [] as typeof loops]));
        for (const hole of holes) {
            const around = outlines
                .filter((outline) => PartSolid.contains(outline.outline, hole.outline[0]))
                .sort((a, b) => Math.abs(a.area) - Math.abs(b.area))[0];
            around && holesOf.get(around)!.push(hole);
        }

        const triangles: number[] = [];
        for (const [outline, inner] of holesOf) {
            const rings = [outline, ...inner];
            const loopPoints = rings.flatMap((ring) => ring.points);
            const holeStarts: number[] = [];
            let count = outline.points.length;
            for (const hole of inner) { holeStarts.push(count); count += hole.points.length; }
            const flatCoordinates = rings.flatMap((ring) => ring.outline.flatMap((point) => [point.x, point.y]));
            for (const corner of Earcut.triangulate(flatCoordinates, holeStarts)) {
                const point = loopPoints[corner];
                triangles.push(points[point * 3], points[point * 3 + 1], points[point * 3 + 2]);
            }
        }
        return triangles.length > 0 ? new Float32Array(triangles) : null;
    }

    // Whether a point is inside a polygon, by counting crossings of a ray from it
    private static contains(polygon: THREE.Vector2[], point: THREE.Vector2): boolean {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const a = polygon[i], b = polygon[j];
            if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) {
                inside = !inside;
            }
        }
        return inside;
    }
}
