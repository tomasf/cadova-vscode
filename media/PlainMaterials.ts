import * as THREE from "three";
import { appearanceDefaults } from "./customizer/meshes.js";

/** How a material looked as the model gave it, kept while it shows plain. */
interface OwnAppearance {
    color: THREE.Color;
    roughness: number;
    metalness: number;
}

/**
 * Cadova Viewer's Materials option, turned off: every part looks the way a part without materials of
 * its own does, matte in the model color, keeping only how see-through it is. Edges turn black,
 * since their light or dark color was chosen against the part's own color.
 */
export class PlainMaterials {
    /** Whether any part looks different from plain, so that turning materials off would change anything. */
    static hasMaterials(model: THREE.Object3D, plainColor: THREE.Color): boolean {
        let found = false;
        model.traverse((child) => {
            if (found || !(child instanceof THREE.Mesh)) return;
            for (const material of PlainMaterials.faceMaterials(child)) {
                const own = PlainMaterials.own(material);
                if (!own.color.equals(plainColor) || own.roughness !== appearanceDefaults.roughness
                    || own.metalness !== appearanceDefaults.metalness) found = true;
            }
        });
        return found;
    }

    /** Shows the model's parts plain, or in their own materials. */
    static show(model: THREE.Object3D, plain: boolean, plainColor: THREE.Color) {
        model.traverse((child) => {
            if (child instanceof THREE.LineSegments) {
                // Edge colors are per vertex, so the material's color scales them all
                (child.material as THREE.LineBasicMaterial).color.set(plain ? 0x000000 : 0xffffff);
            } else if (child instanceof THREE.Mesh) {
                for (const material of PlainMaterials.faceMaterials(child)) {
                    const own = PlainMaterials.own(material);
                    material.color.copy(plain ? plainColor : own.color);
                    material.roughness = plain ? appearanceDefaults.roughness : own.roughness;
                    material.metalness = plain ? appearanceDefaults.metalness : own.metalness;
                }
            }
        });
    }

    /** Runs something, such as drawing a part's picture, with the model in its own materials. */
    static withOwnMaterials<T>(object: THREE.Object3D, body: () => T): T {
        const plain: { material: THREE.MeshStandardMaterial; color: THREE.Color; roughness: number; metalness: number }[] = [];
        object.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            for (const material of PlainMaterials.faceMaterials(child)) {
                const own = material.userData.ownAppearance as OwnAppearance | undefined;
                if (!own) continue;
                plain.push({ material, color: material.color.clone(), roughness: material.roughness, metalness: material.metalness });
                material.color.copy(own.color);
                material.roughness = own.roughness;
                material.metalness = own.metalness;
            }
        });
        try {
            return body();
        } finally {
            for (const { material, color, roughness, metalness } of plain) {
                material.color.copy(color);
                material.roughness = roughness;
                material.metalness = metalness;
            }
        }
    }

    // How a material looked before it was first shown plain
    private static own(material: THREE.MeshStandardMaterial): OwnAppearance {
        material.userData.ownAppearance ??= {
            color: material.color.clone(), roughness: material.roughness, metalness: material.metalness,
        } satisfies OwnAppearance;
        return material.userData.ownAppearance;
    }

    private static faceMaterials(mesh: THREE.Mesh): THREE.MeshStandardMaterial[] {
        return (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
            .filter((material): material is THREE.MeshStandardMaterial => material instanceof THREE.MeshStandardMaterial);
    }
}
