import {
  Camera,
  Entity,
  Material,
  Mesh,
  MeshRenderer,
  ModelMesh,
  Skin,
  SkinnedMeshRenderer
} from "@galacean/engine-core";
import { BoundingBox, Matrix } from "@galacean/engine-math";
import { GLTFResource } from "../GLTFResource";
import { CameraType, ICamera, INode } from "../GLTFSchema";
import { GLTFMaterialParser } from "./GLTFMaterialParser";
import { GLTFParser } from "./GLTFParser";
import { GLTFParserContext, GLTFParserType, registerGLTFParser } from "./GLTFParserContext";

@registerGLTFParser(GLTFParserType.Scene)
export class GLTFSceneParser extends GLTFParser {
  parse(context: GLTFParserContext, index: number): Promise<Entity> {
    const {
      glTF: { scenes, scene = 0 },
      glTFResource
    } = context;
    const sceneInfo = scenes[index];
    const sceneExtensions = sceneInfo.extensions;

    const engine = glTFResource.engine;
    const isDefaultScene = scene === index;
    const sceneNodes = sceneInfo.nodes;
    let sceneRoot: Entity;

    if (sceneNodes.length === 1) {
      sceneRoot = context.get<Entity>(GLTFParserType.Entity, sceneNodes[0]);
    } else {
      sceneRoot = new Entity(engine, "GLTF_ROOT");
      for (let i = 0; i < sceneNodes.length; i++) {
        const childEntity = context.get<Entity>(GLTFParserType.Entity, sceneNodes[i]);
        sceneRoot.addChild(childEntity);
      }
    }

    // @ts-ignore
    sceneRoot._hookResource = glTFResource;
    // @ts-ignore
    glTFResource._addReferCount(1);

    if (isDefaultScene) {
      glTFResource.defaultSceneRoot = sceneRoot;
    }

    const promises = new Array<Promise<void[]>>();

    for (let i = 0; i < sceneNodes.length; i++) {
      promises.push(this._parseEntityComponent(context, sceneNodes[i]));
    }

    return Promise.all(promises).then(() => {
      GLTFParser.executeExtensionsAdditiveAndParse(sceneExtensions, context, sceneRoot, sceneInfo);
      return sceneRoot;
    });
  }

  private _parseEntityComponent(context: GLTFParserContext, index: number): Promise<void[]> {
    const { glTF, glTFResource } = context;
    const entityInfo = glTF.nodes[index];
    const { camera: cameraID, mesh: meshID } = entityInfo;
    const entity = context.get<Entity>(GLTFParserType.Entity, index);
    let promise: Promise<void[]>;

    if (cameraID !== undefined) {
      this._createCamera(glTFResource, glTF.cameras[cameraID], entity);
    }

    if (meshID !== undefined) {
      promise = this._createRenderer(context, entityInfo, entity);
    }

    return Promise.resolve(promise).then(() => {
      const promises = [];
      const children = entityInfo.children;

      if (children) {
        for (let i = 0; i < children.length; i++) {
          promises.push(this._parseEntityComponent(context, children[i]));
        }
      }

      return Promise.all(promises);
    });
  }

  private _createCamera(resource: GLTFResource, cameraSchema: ICamera, entity: Entity): void {
    const { orthographic, perspective, type } = cameraSchema;
    const camera = entity.addComponent(Camera);

    if (type === CameraType.ORTHOGRAPHIC) {
      const { xmag, ymag, zfar, znear } = orthographic;

      camera.isOrthographic = true;

      if (znear !== undefined) {
        camera.nearClipPlane = znear;
      }
      if (zfar !== undefined) {
        camera.farClipPlane = zfar;
      }

      camera.orthographicSize = Math.max(ymag ?? 0, xmag ?? 0) / 2;
    } else if (type === CameraType.PERSPECTIVE) {
      const { aspectRatio, yfov, zfar, znear } = perspective;

      if (aspectRatio !== undefined) {
        camera.aspectRatio = aspectRatio;
      }
      if (yfov !== undefined) {
        camera.fieldOfView = (yfov * 180) / Math.PI;
      }
      if (zfar !== undefined) {
        camera.farClipPlane = zfar;
      }
      if (znear !== undefined) {
        camera.nearClipPlane = znear;
      }
    }

    resource.cameras ||= [];
    resource.cameras.push(camera);
    // @todo: use engine camera by default
    camera.enabled = false;
  }

  private _createRenderer(context: GLTFParserContext, entityInfo: INode, entity: Entity): Promise<void[]> {
    const glTFMeshes = context.glTF.meshes;
    const { mesh: meshID, skin: skinID } = entityInfo;
    const glTFMesh = glTFMeshes[meshID];
    const glTFMeshPrimitives = glTFMesh.primitives;
    const blendShapeWeights = entityInfo.weights || glTFMesh.weights;
    const promises = new Array<Promise<void>>();

    for (let i = 0; i < glTFMeshPrimitives.length; i++) {
      const glTFPrimitive = glTFMeshPrimitives[i];
      const materialIndex = glTFPrimitive.material;

      promises.push(
        Promise.all([
          context.get<ModelMesh[]>(GLTFParserType.Mesh, meshID),
          skinID !== undefined && context.get<Skin>(GLTFParserType.Skin, skinID),
          materialIndex !== undefined && context.get<Material>(GLTFParserType.Material, materialIndex)
        ]).then(([meshes, skin, material]) => {
          const mesh = meshes[i];
          let renderer: MeshRenderer | SkinnedMeshRenderer;

          material ||= GLTFMaterialParser._getDefaultMaterial(context.glTFResource.engine);

          if (skin || blendShapeWeights) {
            const skinRenderer = entity.addComponent(SkinnedMeshRenderer);
            skinRenderer.mesh = mesh;
            if (skin) {
              skinRenderer.rootBone = skin._rootBone;
              skinRenderer.bones = skin._bones;
              this._computeLocalBounds(skinRenderer, mesh, skin._bones, skin._rootBone, skin.inverseBindMatrices);

              skinRenderer.skin = skin;
            }
            if (blendShapeWeights) {
              skinRenderer.blendShapeWeights = new Float32Array(blendShapeWeights);
            }
            renderer = skinRenderer;
          } else {
            renderer = entity.addComponent(MeshRenderer);
            renderer.mesh = mesh;
          }

          renderer.setMaterial(material);

          // Enable vertex color if mesh has COLOR_0 vertex element
          mesh.vertexElements.forEach((element) => {
            if (element.semantic === "COLOR_0") {
              renderer.enableVertexColor = true;
            }
          });

          GLTFParser.executeExtensionsAdditiveAndParse(glTFPrimitive.extensions, context, renderer, glTFPrimitive);
        })
      );
    }

    return Promise.all(promises);
  }

  private _computeLocalBounds(
    skinnedMeshRenderer: SkinnedMeshRenderer,
    mesh: Mesh,
    bones: Entity[],
    rootBone: Entity,
    inverseBindMatrices: Matrix[]
  ): void {
    const rootBoneIndex = bones.indexOf(rootBone);
    if (rootBoneIndex !== -1) {
      BoundingBox.transform(mesh.bounds, inverseBindMatrices[rootBoneIndex], skinnedMeshRenderer.localBounds);
    } else {
      // Root bone is not in joints list, we can only compute approximate inverse bind matrix
      // Average all root bone's children inverse bind matrix
      const approximateBindMatrix = new Matrix(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      let subRootBoneCount = this._computeApproximateBindMatrix(
        bones,
        inverseBindMatrices,
        rootBone,
        approximateBindMatrix
      );

      if (subRootBoneCount !== 0) {
        Matrix.multiplyScalar(approximateBindMatrix, 1.0 / subRootBoneCount, approximateBindMatrix);
        BoundingBox.transform(mesh.bounds, approximateBindMatrix, skinnedMeshRenderer.localBounds);
      } else {
        skinnedMeshRenderer.localBounds.copyFrom(mesh.bounds);
      }
    }
  }

  private _computeApproximateBindMatrix(
    jointEntities: Entity[],
    inverseBindMatrices: Matrix[],
    rootEntity: Entity,
    approximateBindMatrix: Matrix
  ): number {
    let subRootBoneCount = 0;
    const children = rootEntity.children;
    for (let i = 0, n = children.length; i < n; i++) {
      const rootChild = children[i];
      const index = jointEntities.indexOf(rootChild);
      if (index !== -1) {
        Matrix.add(approximateBindMatrix, inverseBindMatrices[index], approximateBindMatrix);
        subRootBoneCount++;
      } else {
        subRootBoneCount += this._computeApproximateBindMatrix(
          jointEntities,
          inverseBindMatrices,
          rootChild,
          approximateBindMatrix
        );
      }
    }

    return subRootBoneCount;
  }
}
