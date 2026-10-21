import * as THREE from "three";

/**
 * An unlit material with Cadova Viewer's diagonal hatch: bands along a direction in world space,
 * with edges softened over about a pixel so they don't shimmer at any zoom. Cross-section cuts use
 * it, in the part's color with stripes in the section's, and so does the plane that shows where a
 * section is.
 */
export class HatchMaterial extends THREE.MeshBasicMaterial {
    readonly hatch = {
        hatchDirection: { value: new THREE.Vector3(1, 0, 0) },
        hatchSpacing: { value: 1 },
        hatchColor: { value: new THREE.Color(0xffffff) },
        hatchAlpha: { value: 1 },
        hatchStrength: { value: 0.2 },
    };

    constructor(parameters: THREE.MeshBasicMaterialParameters) {
        super({ side: THREE.DoubleSide, toneMapped: false, ...parameters });
        this.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, this.hatch);
            shader.vertexShader = shader.vertexShader
                .replace("#include <common>", "#include <common>\nvarying vec3 vHatchWorld;")
                .replace("#include <project_vertex>", `#include <project_vertex>
                    vHatchWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
            shader.fragmentShader = shader.fragmentShader
                .replace("#include <common>", `#include <common>
                    varying vec3 vHatchWorld;
                    uniform vec3 hatchDirection;
                    uniform float hatchSpacing;
                    uniform vec3 hatchColor;
                    uniform float hatchAlpha;
                    uniform float hatchStrength;`)
                .replace("#include <color_fragment>", `#include <color_fragment>
                    float hatchCoordinate = dot(vHatchWorld, hatchDirection) / hatchSpacing;
                    float hatchWidth = fwidth(hatchCoordinate);
                    float hatchBand = 1.0 - smoothstep(0.5 - hatchWidth, 0.5 + hatchWidth, fract(hatchCoordinate));
                    diffuseColor = mix(diffuseColor, vec4(hatchColor, hatchAlpha), hatchBand * hatchStrength);`);
        };
    }
}
