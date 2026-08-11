import { useEffect, useRef } from "react";
import type { Material, Object3D, Texture } from "three";

interface DisposableController {
  dispose: () => void;
}

function disposeMaterial(material: Material) {
  const values = Object.values(material) as unknown[];
  values.forEach((value) => {
    if (value && typeof value === "object" && "isTexture" in value) {
      (value as Texture).dispose();
    }
  });
  material.dispose();
}

export function disposeSceneGraph(root: Object3D) {
  root.traverse((object) => {
    const renderable = object as Object3D & {
      geometry?: { dispose: () => void };
      material?: Material | Material[];
    };
    renderable.geometry?.dispose();
    if (Array.isArray(renderable.material)) {
      renderable.material.forEach(disposeMaterial);
    } else if (renderable.material) {
      disposeMaterial(renderable.material);
    }
  });
}

export function useThreeScene<T extends DisposableController>(
  createController: (host: HTMLDivElement) => T,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<T | null>(null);
  const factoryRef = useRef(createController);
  factoryRef.current = createController;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = factoryRef.current(host);
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  return { hostRef, controllerRef };
}
