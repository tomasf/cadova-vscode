import * as THREE from "three";

/** What Cadova Viewer's info sheet says about a model's geometry. */
interface GeometryStats {
    dimensions: THREE.Vector3;
    volume: number;
    surfaceArea: number;
    parts: number;
    vertices: number;
    triangles: number;
}

/** A model as the info panel describes it. */
export interface ModelInfo {
    name: string;
    fileSize: number;
    stats: GeometryStats;
    metadata: { name: string; value: string }[];
}

/**
 * The panel over the view's corner that tells about the model, with the rows of Cadova Viewer's info
 * sheet: its file, its geometry, and the metadata in the 3MF file.
 */
export class InfoPanel {
    private readonly element = document.getElementById("info")!;

    // Cadova Viewer's labels for 3MF's standard metadata, in its order; other names come after
    private static readonly metadataLabels: Record<string, string> = {
        Title: "Title", Designer: "Designer", Description: "Description", Copyright: "Copyright",
        LicenseTerms: "License Terms", Rating: "Rating", CreationDate: "Creation Date",
        ModificationDate: "Modification Date", Application: "Application",
    };

    set visible(visible: boolean) {
        this.element.hidden = !visible;
    }

    show(info: ModelInfo) {
        const { stats } = info;
        const sections: [string, string][][] = [
            [["Name", info.name], ["File Size", InfoPanel.fileSize(info.fileSize)]],
            [
                ["Dimensions", `${[stats.dimensions.x, stats.dimensions.y, stats.dimensions.z].map((value) => InfoPanel.number(value, 2)).join(" × ")} mm`],
                ["Volume", `${InfoPanel.number(stats.volume, 0)} mm³`],
                ["Surface Area", `${InfoPanel.number(stats.surfaceArea, 0)} mm²`],
                ["Parts", InfoPanel.number(stats.parts, 0)],
                ["Vertices", InfoPanel.number(stats.vertices, 0)],
                ["Triangles", InfoPanel.number(stats.triangles, 0)],
            ],
            InfoPanel.metadataRows(info.metadata),
        ];

        this.element.replaceChildren(...sections.filter((rows) => rows.length > 0).map((rows) => {
            const list = document.createElement("dl");
            for (const [label, value] of rows) {
                list.append(
                    Object.assign(document.createElement("dt"), { textContent: label }),
                    Object.assign(document.createElement("dd"), { textContent: value }),
                );
            }
            return list;
        }));
    }

    /**
     * Measures a model's parts as they were read, before smoothing their normals unshares their
     * vertices: a part's meshes, one per material, share its vertices then.
     */
    static measure(object: THREE.Object3D): GeometryStats {
        object.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(object);
        const stats: GeometryStats = {
            dimensions: box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3()),
            volume: 0, surfaceArea: 0, parts: object.children.length, vertices: 0, triangles: 0,
        };
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        const cross = new THREE.Vector3();
        for (const part of object.children) {
            const positions = new Set<THREE.BufferAttribute>();
            let signedVolume = 0;
            part.traverse((child) => {
                if (!(child instanceof THREE.Mesh) || !child.geometry.index) return;
                const position = child.geometry.attributes.position as THREE.BufferAttribute;
                positions.add(position);
                const index = child.geometry.index.array;
                stats.triangles += index.length / 3;
                for (let i = 0; i < index.length; i += 3) {
                    a.fromBufferAttribute(position, index[i]).applyMatrix4(child.matrixWorld);
                    b.fromBufferAttribute(position, index[i + 1]).applyMatrix4(child.matrixWorld);
                    c.fromBufferAttribute(position, index[i + 2]).applyMatrix4(child.matrixWorld);
                    signedVolume += a.dot(cross.crossVectors(b, c)) / 6;
                    stats.surfaceArea += cross.subVectors(b, a).cross(c.sub(a)).length() / 2;
                }
            });
            // A mirroring transform turns a part inside out, so each part's volume counts as positive
            stats.volume += Math.abs(signedVolume);
            for (const position of positions) stats.vertices += position.count;
        }
        return stats;
    }

    private static metadataRows(metadata: { name: string; value: string }[]): [string, string][] {
        const order = Object.keys(InfoPanel.metadataLabels);
        const rank = (name: string) => order.includes(name) ? order.indexOf(name) : order.length;
        const values = new Map<string, string[]>();
        for (const { name, value } of metadata) values.set(name, [...values.get(name) ?? [], value]);
        return [...values]
            .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
            .map(([name, entries]) => [InfoPanel.metadataLabels[name] ?? name, entries.join("\n")]);
    }

    private static number(value: number, fractionDigits: number): string {
        return value.toLocaleString(undefined, { maximumFractionDigits: fractionDigits });
    }

    // Like macOS's file sizes: decimal units, such as 7.7 MB
    private static fileSize(bytes: number): string {
        const units = ["bytes", "KB", "MB", "GB"];
        let value = bytes, unit = 0;
        while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
        return unit === 0 ? `${bytes} bytes` : `${InfoPanel.number(value, 1)} ${units[unit]}`;
    }
}
