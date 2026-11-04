import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import maplibregl from 'maplibre-gl';

// ============================================================================
// 1. GIANT & WORLD STATE
// ============================================================================
const state = {
  lng: -74.0060,
  lat: 40.7128,
  giantHeightMeters: 65,      // 65m tall (~20 stories high; skyscrapers still tower around you)
  headingRad: 0,              // Direction the giant's body is facing (0 = North, CW)
  cameraBearing: 25,          // Direction the camera is looking (degrees, 0 = North, CW)
  cameraPitch: 68,            // Camera tilt (degrees, 0 = top-down, 85 = horizon)
  cameraMode: 'third-person', // 'third-person' | 'first-person'
  drawTrail: true,
  mapVisualMode: 'arcade',    // 'arcade' | 'satellite' | 'vector' | 'sketch'
  keys: {
    w: false,
    a: false,
    s: false,
    d: false,
    shift: false,
    q: false,
    e: false,
    space: false,
  },
  verticalVelocity: 0,
  altitudeMeters: 0,          // Jump height off the street
  stepDistanceAccum: 0,
  totalDistanceMeters: 0,
  totalSteps: 0,
  trashCollected: 0,
  walkEnded: false,           // True when "End Walk" is clicked (aerial map overview mode)
  trailCoords: [[-74.0060, 40.7128]],
  footprints: [],             // Expanding ink rings on the street where the giant steps
  trashItems: [],             // Active 3D street trash items around the world
  collectedTrashCoords: [],   // Coordinates where Crabby cleaned up trash
};

// ============================================================================
// 2. INITIALIZE MAPLIBRE 3D WORLD (OpenFreeMap — No API Key Required)
// ============================================================================
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [state.lng, state.lat],
  zoom: 17.2,
  pitch: state.cameraPitch,
  bearing: state.cameraBearing,
  maxPitch: 85,
  antialias: true,
  keyboard: false, // We handle WASD / Arrows for the giant character
});

// Disable default left-drag pan so mouse drag rotates the giant's look camera
map.dragPan.disable();
map.doubleClickZoom.disable();

// ============================================================================
// 3. CUSTOM THREE.JS LAYER (Renders Giant & Footstep Rings in Map Depth Buffer)
// ============================================================================
class GiantCustomLayer {
  constructor() {
    this.id = 'three-giant-layer';
    this.type = 'custom';
    this.renderingMode = '3d';

    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();

    // Root group oriented in real-world meters at the giant's (lng, lat):
    // +X = East, +Y = Up (meters), +Z = South
    this.giantRoot = new THREE.Group();
    this.scene.add(this.giantRoot);

    // Character container that rotates with heading & jumps in Y
    this.characterHolder = new THREE.Group();
    this.giantRoot.add(this.characterHolder);

    // Footstep rings group (in meter coordinates relative to giant)
    this.footprintsGroup = new THREE.Group();
    this.giantRoot.add(this.footprintsGroup);

    // 3D Street Trash items group (in meter coordinates relative to giant)
    this.trashGroup = new THREE.Group();
    this.giantRoot.add(this.trashGroup);

    this.mixer = null;
    this.actions = {};
    this.activeActionName = '';
    this.clock = new THREE.Clock();
    this.proceduralRig = null;
  }

  onAdd(mapInstance, gl) {
    this.map = mapInstance;

    // Balanced lighting so Rabby's 3D contours and rich blue shading stay crisp (not overexposed)
    const hemiLight = new THREE.HemisphereLight(0xbae6fd, 0x0f172a, 1.1);
    hemiLight.position.set(0, 200, 0);
    this.scene.add(hemiLight);

    const sunLight = new THREE.DirectionalLight(0xe0f2fe, 1.65);
    sunLight.position.set(120, 260, 140);
    this.scene.add(sunLight);

    const cyanRimLight = new THREE.DirectionalLight(0x00b4d8, 1.25);
    cyanRimLight.position.set(-140, 110, -120);
    this.scene.add(cyanRimLight);

    const blueFrontLight = new THREE.DirectionalLight(0x0284c7, 0.8);
    blueFrontLight.position.set(140, 90, 140);
    this.scene.add(blueFrontLight);

    // Soft dark ground shadow disc + neon-blue arcade base ring beneath the giant's feet
    const shadowGeo = new THREE.CircleGeometry(0.35, 32);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x050814,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    this.shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadowMesh.position.y = 0.01;

    const baseRingGeo = new THREE.RingGeometry(0.31, 0.37, 32);
    baseRingGeo.rotateX(-Math.PI / 2);
    const baseRingMat = new THREE.MeshBasicMaterial({
      color: 0x0088ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const baseRingMesh = new THREE.Mesh(baseRingGeo, baseRingMat);
    baseRingMesh.position.y = 0.005;
    this.shadowMesh.add(baseRingMesh);

    this.giantRoot.add(this.shadowMesh);

    // Floating spinning cobalt-blue neon halo above the crabby giant's head
    const haloGeo = new THREE.TorusGeometry(0.15, 0.02, 12, 24);
    haloGeo.rotateX(Math.PI / 2);
    const haloMat = new THREE.MeshStandardMaterial({
      color: 0x0077ff,
      emissive: 0x0044aa,
      emissiveIntensity: 0.45,
      roughness: 0.25,
    });
    this.funkyHalo = new THREE.Mesh(haloGeo, haloMat);
    this.funkyHalo.position.y = 1.08;
    this.characterHolder.add(this.funkyHalo);

    // 1) Create immediate procedural articulated crab-giant so it's visible instantly
    this.buildProceduralFallbackGiant();

    // 2) Load animated GLTF character (RobotExpressive from Three.js examples) & apply deeper blue palette
    this.loadAnimatedGLTFCharacter();

    // 3) Scatter initial 3D street trash around the city for Crabby to pick up
    this.spawnTrashCluster(state.lng, state.lat, 24);

    this.renderer = new THREE.WebGLRenderer({
      canvas: mapInstance.getCanvas(),
      context: gl,
      antialias: true,
    });
    this.renderer.autoClear = false;
  }

  buildProceduralFallbackGiant() {
    const group = new THREE.Group();
    const neonBlueShellMat = new THREE.MeshStandardMaterial({
      color: 0x0055ff,
      emissive: 0x001a66,
      emissiveIntensity: 0.25,
      roughness: 0.32,
      metalness: 0.3,
    });
    const iceCyanClawMat = new THREE.MeshStandardMaterial({
      color: 0x0096c7,
      emissive: 0x002845,
      emissiveIntensity: 0.2,
      roughness: 0.28,
      metalness: 0.35,
    });
    const limeEyeMat = new THREE.MeshStandardMaterial({
      color: 0xe2ff00,
      emissive: 0x88bb00,
      emissiveIntensity: 0.5,
      roughness: 0.2,
    });

    // Wide crabby torso & head normalized to ~1.0 unit tall
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.3, 0.2), neonBlueShellMat);
    torso.position.y = 0.52;
    group.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.2), neonBlueShellMat);
    head.position.y = 0.8;
    group.add(head);

    // Glowing acid-lime eye visor
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 0.21), limeEyeMat);
    visor.position.y = 0.81;
    group.add(visor);

    // Crabby side pincer arms
    const leftClaw = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 0.12), iceCyanClawMat);
    leftClaw.position.set(-0.24, 0.54, 0.04);
    leftClaw.rotation.z = 0.35;
    group.add(leftClaw);

    const rightClaw = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 0.12), iceCyanClawMat);
    rightClaw.position.set(0.24, 0.54, 0.04);
    rightClaw.rotation.z = -0.35;
    group.add(rightClaw);

    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.38, 0.11), iceCyanClawMat);
    leftLeg.position.set(-0.1, 0.19, 0);
    group.add(leftLeg);

    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.38, 0.11), iceCyanClawMat);
    rightLeg.position.set(0.1, 0.19, 0);
    group.add(rightLeg);

    this.proceduralRig = { group, leftLeg, rightLeg, head };
    this.characterHolder.add(group);
  }

  styleCrabbyGLTFMaterials(model) {
    // Rich Cobalt Blue & Deep Electric Cyan materials with controlled emissive so 3D shading stays crisp
    const electricBlueArmor = new THREE.MeshStandardMaterial({
      name: 'CobaltBlueArmor',
      color: 0x0055ff,
      emissive: 0x001a66,
      emissiveIntensity: 0.25,
      roughness: 0.32,
      metalness: 0.3,
    });

    const deepCyanJoints = new THREE.MeshStandardMaterial({
      name: 'DeepCyanClaws',
      color: 0x00a8e8,
      emissive: 0x002b49,
      emissiveIntensity: 0.2,
      roughness: 0.28,
      metalness: 0.38,
    });

    const acidLimeEyes = new THREE.MeshStandardMaterial({
      name: 'AcidLimeEyes',
      color: 0xe2ff00,
      emissive: 0x77aa00,
      emissiveIntensity: 0.45,
      roughness: 0.2,
      metalness: 0.1,
    });

    const mapMaterial = (mat) => {
      if (!mat) return electricBlueArmor;
      const matName = (mat.name || '').toLowerCase();
      // 'Main' shell -> Rich Cobalt Blue
      if (matName.includes('main') || matName.includes('orange')) {
        return electricBlueArmor;
      }
      // 'Grey' claws, joints, legs & antenna -> Deep Cyan-Teal
      if (matName.includes('grey') || matName.includes('gray')) {
        return deepCyanJoints;
      }
      // 'Black' eyes & visor details -> Acid Lime
      if (matName.includes('black') || matName.includes('dark')) {
        return acidLimeEyes;
      }
      // Fallback by original color brightness
      if (mat.color) {
        const lum = mat.color.r * 0.3 + mat.color.g * 0.59 + mat.color.b * 0.11;
        if (lum < 0.2) return acidLimeEyes;
        if (mat.color.r > mat.color.b * 1.4) return electricBlueArmor;
      }
      return deepCyanJoints;
    };

    model.traverse((child) => {
      if (child.isMesh) {
        if (Array.isArray(child.material)) {
          child.material = child.material.map(mapMaterial);
        } else {
          child.material = mapMaterial(child.material);
        }
      }
    });
  }

  loadAnimatedGLTFCharacter() {
    const loader = new GLTFLoader();
    const modelUrl =
      'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/RobotExpressive/RobotExpressive.glb';

    loader.load(
      modelUrl,
      (gltf) => {
        const model = gltf.scene;

        // Restyle the crabby robot with our funky hot-pink / neon-cyan / acid-lime vibe
        this.styleCrabbyGLTFMaterials(model);

        // Measure model bounding box so we normalize its height to 1.0 unit (= 1 meter before giant scale)
        const box = new THREE.Box3().setFromObject(model);
        const size = new THREE.Vector3();
        box.getSize(size);
        const normalizedScale = 1.0 / (size.y || 4.0);
        model.scale.setScalar(normalizedScale);

        // Remove fallback rig and attach animated GLTF character
        if (this.proceduralRig) {
          this.characterHolder.remove(this.proceduralRig.group);
          this.proceduralRig = null;
        }

        this.gltfModel = model;
        this.characterHolder.add(model);

        // Setup AnimationMixer for Idle, Walking, Running, Jump, Wave
        this.mixer = new THREE.AnimationMixer(model);
        for (const clip of gltf.animations) {
          this.actions[clip.name] = this.mixer.clipAction(clip);
        }

        this.fadeToAction('Idle', 0.2);
      },
      undefined,
      () => {
        // Keep procedural fallback if offline
      }
    );
  }

  fadeToAction(name, duration = 0.2) {
    if (!this.actions[name] || this.activeActionName === name) return;

    const prevAction = this.actions[this.activeActionName];
    const nextAction = this.actions[name];
    this.activeActionName = name;

    if (prevAction) {
      prevAction.fadeOut(duration);
    }

    nextAction
      .reset()
      .setEffectiveTimeScale(1)
      .setEffectiveWeight(1)
      .fadeIn(duration)
      .play();
  }

  spawnFootstepRing(lng, lat) {
    const ringGeo = new THREE.RingGeometry(0.08, 0.13, 28);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00f0ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(ringGeo, ringMat);
    state.footprints.push({
      lng,
      lat,
      age: 0,
      maxAge: 6.0,
      mesh,
    });
    this.footprintsGroup.add(mesh);
  }

  updateFootprints(dt) {
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos((state.lat * Math.PI) / 180);

    for (let i = state.footprints.length - 1; i >= 0; i--) {
      const fp = state.footprints[i];
      fp.age += dt;
      if (fp.age >= fp.maxAge) {
        this.footprintsGroup.remove(fp.mesh);
        fp.mesh.geometry.dispose();
        fp.mesh.material.dispose();
        state.footprints.splice(i, 1);
        continue;
      }

      const progress = fp.age / fp.maxAge;
      const scale = 1 + progress * 3.5;
      fp.mesh.scale.setScalar(scale);
      fp.mesh.material.opacity = (1 - progress) * 0.8;

      // Position relative to the giantRoot in normalized giant units
      const dxMeters = (fp.lng - state.lng) * metersPerDegLng;
      const dzMeters = -(fp.lat - state.lat) * metersPerDegLat;
      const invScale = 1 / state.giantHeightMeters;
      fp.mesh.position.set(dxMeters * invScale, 0.015, dzMeters * invScale);
    }
  }

  createTrashMesh(type) {
    const holder = new THREE.Group();
    const propGroup = new THREE.Group();

    // Glowing acid-lime street beacon ring under each piece of trash so it's easy to spot
    const beaconGeo = new THREE.RingGeometry(0.14, 0.2, 24);
    beaconGeo.rotateX(-Math.PI / 2);
    const beaconMat = new THREE.MeshBasicMaterial({
      color: 0xe2ff00,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    const beaconRing = new THREE.Mesh(beaconGeo, beaconMat);
    beaconRing.position.y = 0.012;
    holder.add(beaconRing);

    if (type === 'soda-can') {
      // Crushed Neon Soda Can
      const canMat = new THREE.MeshStandardMaterial({
        color: 0xff2a85,
        emissive: 0x4a0424,
        roughness: 0.25,
        metalness: 0.5,
      });
      const lidMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        roughness: 0.2,
        metalness: 0.8,
      });
      const canBody = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.22, 14), canMat);
      const topRim = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.03, 14), lidMat);
      topRim.position.y = 0.11;
      canBody.add(topRim);
      canBody.rotation.z = 0.45;
      canBody.rotation.x = 0.2;
      propGroup.add(canBody);
    } else if (type === 'trash-bag') {
      // Tied Hefty Trash Bag with Acid-Lime Knot
      const bagMat = new THREE.MeshStandardMaterial({
        color: 0x1e1b4b,
        emissive: 0x0f0728,
        roughness: 0.22,
        metalness: 0.3,
      });
      const tieMat = new THREE.MeshStandardMaterial({
        color: 0xe2ff00,
        emissive: 0x668800,
        roughness: 0.3,
      });
      const bagBody = new THREE.Mesh(new THREE.DodecahedronGeometry(0.13, 1), bagMat);
      bagBody.scale.set(1.0, 1.15, 1.0);
      const knot = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.08, 8), tieMat);
      knot.position.y = 0.15;
      knot.rotation.x = Math.PI;
      propGroup.add(bagBody, knot);
    } else if (type === 'pizza-box') {
      // Discarded Street Pizza Box
      const boxMat = new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0x451a03,
        roughness: 0.45,
      });
      const stripeMat = new THREE.MeshStandardMaterial({
        color: 0xff2a85,
        emissive: 0x3b041c,
        roughness: 0.3,
      });
      const boxBase = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.045, 0.24), boxMat);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.16), stripeMat);
      boxBase.add(stripe);
      boxBase.rotation.z = 0.22;
      boxBase.rotation.x = -0.18;
      propGroup.add(boxBase);
    } else {
      // Glowing Plastic Bottle
      const bottleMat = new THREE.MeshStandardMaterial({
        color: 0x10b981,
        emissive: 0x065f46,
        roughness: 0.15,
        metalness: 0.2,
      });
      const capMat = new THREE.MeshStandardMaterial({
        color: 0xe2ff00,
        emissive: 0x88aa00,
        roughness: 0.2,
      });
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.2, 12), bottleMat);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.06, 10), bottleMat);
      neck.position.y = 0.12;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.03, 10), capMat);
      cap.position.y = 0.16;
      bottle.add(neck, cap);
      bottle.rotation.z = -0.5;
      propGroup.add(bottle);
    }

    propGroup.position.y = 0.16;
    holder.add(propGroup);
    return { holder, propGroup, beaconRing };
  }

  spawnSingleTrashNear(centerLng, centerLat, minDistMeters = 45, maxDistMeters = 420) {
    const types = [
      { type: 'soda-can', label: 'CRUSHED SODA CAN' },
      { type: 'trash-bag', label: 'STREET TRASH BAG' },
      { type: 'pizza-box', label: 'GREASY PIZZA BOX' },
      { type: 'plastic-bottle', label: 'PLASTIC BOTTLE' },
    ];
    const chosen = types[Math.floor(Math.random() * types.length)];

    const angle = Math.random() * Math.PI * 2;
    const dist = minDistMeters + Math.random() * (maxDistMeters - minDistMeters);
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos((centerLat * Math.PI) / 180);

    const lat = centerLat + (Math.cos(angle) * dist) / metersPerDegLat;
    const lng = centerLng + (Math.sin(angle) * dist) / metersPerDegLng;

    const { holder, propGroup, beaconRing } = this.createTrashMesh(chosen.type);
    this.trashGroup.add(holder);

    const item = {
      lng,
      lat,
      type: chosen.type,
      label: chosen.label,
      mesh: holder,
      propGroup,
      beaconRing,
      phase: Math.random() * Math.PI * 2,
      spinSpeed: (Math.random() * 0.8 + 0.8) * (Math.random() < 0.5 ? 1 : -1),
      collecting: false,
      collectProgress: 0,
    };

    state.trashItems.push(item);
    return item;
  }

  spawnTrashCluster(centerLng, centerLat, count = 24) {
    // Clear existing trash meshes
    for (const item of state.trashItems) {
      this.trashGroup.remove(item.mesh);
    }
    state.trashItems = [];

    // Spawn a few pieces close by (35m - 120m) so Crabby sees trash immediately, and the rest further out
    for (let i = 0; i < count; i++) {
      if (i < 6) {
        this.spawnSingleTrashNear(centerLng, centerLat, 35, 125);
      } else {
        this.spawnSingleTrashNear(centerLng, centerLat, 125, 460);
      }
    }
    updateTrashMapGeoJSON();
  }

  updateTrashItems(dt) {
    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos((state.lat * Math.PI) / 180);
    const invScale = 1 / state.giantHeightMeters;
    const pickupRadiusMeters = state.giantHeightMeters * 0.45;
    const now = performance.now() * 0.003;
    let mapSourceNeedsUpdate = false;

    for (let i = state.trashItems.length - 1; i >= 0; i--) {
      const item = state.trashItems[i];
      const dxMeters = (item.lng - state.lng) * metersPerDegLng;
      const dzMeters = -(item.lat - state.lat) * metersPerDegLat;
      const distMeters = Math.hypot(dxMeters, dzMeters);

      // If Crabby walked very far away (> 620m), recycle this piece of trash closer ahead
      if (!item.collecting && distMeters > 620) {
        this.trashGroup.remove(item.mesh);
        state.trashItems.splice(i, 1);
        this.spawnSingleTrashNear(state.lng, state.lat, 140, 440);
        mapSourceNeedsUpdate = true;
        continue;
      }

      // Check if Crabby is close enough to pick up the trash!
      if (!state.walkEnded && !item.collecting && distMeters <= pickupRadiusMeters) {
        item.collecting = true;
        state.trashCollected += 1;
        state.collectedTrashCoords.push([item.lng, item.lat]);
        onTrashPickedUp(item);
        mapSourceNeedsUpdate = true;
      }

      if (item.collecting) {
        item.collectProgress += dt * 3.2;
        if (item.collectProgress >= 1) {
          this.trashGroup.remove(item.mesh);
          state.trashItems.splice(i, 1);
          // Spawn a replacement piece of trash further out so the world stays stocked
          this.spawnSingleTrashNear(state.lng, state.lat, 150, 460);
          mapSourceNeedsUpdate = true;
          continue;
        }
        // Fly up into Crabby's claws while spinning & shrinking
        const p = item.collectProgress;
        const curX = dxMeters * invScale * (1 - p);
        const curZ = dzMeters * invScale * (1 - p);
        const curY = p * 0.58;
        item.mesh.position.set(curX, curY, curZ);
        item.mesh.scale.setScalar(1 - p * 0.85);
        item.propGroup.rotation.y += dt * 14;
      } else {
        // Idle street bob & spin
        item.mesh.position.set(dxMeters * invScale, 0, dzMeters * invScale);
        item.propGroup.position.y = 0.16 + Math.sin(now + item.phase) * 0.04;
        item.propGroup.rotation.y += dt * item.spinSpeed;
        const pulse = 1 + Math.sin(now * 1.5 + item.phase) * 0.15;
        item.beaconRing.scale.setScalar(pulse);
      }
    }

    if (mapSourceNeedsUpdate) {
      updateTrashMapGeoJSON();
    }
  }

  render(gl, matrix) {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    updateGiantMovement(dt, this);
    this.updateFootprints(dt);
    this.updateTrashItems(dt);

    if (this.mixer) {
      this.mixer.update(dt);
    }

    if (this.funkyHalo) {
      const t = performance.now() * 0.004;
      this.funkyHalo.position.y = 1.07 + Math.sin(t) * 0.03;
      this.funkyHalo.rotation.z = Math.sin(t * 0.7) * 0.18;
      this.funkyHalo.rotation.y += dt * 2.2;
    }

    // Hide giant mesh in 1st-person mode (unless viewing from aerial End Walk mode)
    this.characterHolder.visible =
      state.cameraMode === 'third-person' || state.walkEnded;

    // Convert Giant's (lng, lat) into MapLibre Mercator coordinates
    const mercatorCoord = maplibregl.MercatorCoordinate.fromLngLat(
      [state.lng, state.lat],
      0
    );
    const meterInMercator = mercatorCoord.meterInMercatorCoordinateUnits();
    const scale = meterInMercator * state.giantHeightMeters;

    // Position character jump height & facing direction
    this.characterHolder.position.y = state.altitudeMeters / state.giantHeightMeters;
    // In our coordinate frame (+X East, +Y Up, +Z South), facing North (heading=0) means looking along -Z (rotation.y = Math.PI)
    this.characterHolder.rotation.y = Math.PI - state.headingRad;

    // Scale shadow slightly as giant jumps
    const jumpFactor = Math.max(0.4, 1 - state.altitudeMeters / (state.giantHeightMeters * 0.8));
    this.shadowMesh.scale.setScalar(jumpFactor);

    // Build transformation from local Three.js space (+Y up) to Web Mercator (+Z up, +Y south)
    const rotationX = new THREE.Matrix4().makeRotationAxis(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2
    );

    const modelMatrix = new THREE.Matrix4()
      .makeTranslation(mercatorCoord.x, mercatorCoord.y, mercatorCoord.z)
      .scale(new THREE.Vector3(scale, -scale, scale))
      .multiply(rotationX);

    const m = new THREE.Matrix4().fromArray(matrix);
    this.camera.projectionMatrix = m.multiply(modelMatrix);

    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.map.triggerRepaint();
  }
}

const giantLayer = new GiantCustomLayer();

// ============================================================================
// 4. MOVEMENT, ANIMATION & GIANT CAMERA CONTROLLER
// ============================================================================
function updateGiantMovement(dt, layer) {
  // When "End Walk" is active, freeze giant movement & let the user view the aerial map
  if (state.walkEnded) {
    state.altitudeMeters = 0;
    state.verticalVelocity = 0;
    layer.fadeToAction(layer.actions['Wave'] ? 'Wave' : 'Idle', 0.3);
    if (layer.proceduralRig) {
      layer.proceduralRig.leftLeg.rotation.x = 0;
      layer.proceduralRig.rightLeg.rotation.x = 0;
    }
    return;
  }

  // Rotate camera with Q / E keys
  const turnSpeedDeg = 95;
  if (state.keys.q) state.cameraBearing -= turnSpeedDeg * dt;
  if (state.keys.e) state.cameraBearing += turnSpeedDeg * dt;

  // Determine input movement vector relative to camera bearing
  let forwardInput = 0;
  let strafeInput = 0;
  if (state.keys.w) forwardInput += 1;
  if (state.keys.s) forwardInput -= 1;
  if (state.keys.d) strafeInput += 1;
  if (state.keys.a) strafeInput -= 1;

  const isMoving = forwardInput !== 0 || strafeInput !== 0;
  const isRunning = state.keys.shift;

  // Giant walking speed scales proportionally with giant height!
  // A 65m giant walks at ~45 m/s and runs at ~100 m/s across city blocks
  const baseSpeed = state.giantHeightMeters * (isRunning ? 1.55 : 0.72);

  if (isMoving) {
    const inputAngle = Math.atan2(strafeInput, forwardInput);
    const moveHeadingRad = (state.cameraBearing * Math.PI) / 180 + inputAngle;

    // Smoothly turn the giant's body toward the movement direction
    const angleDiff = normalizeAngle(moveHeadingRad - state.headingRad);
    state.headingRad += angleDiff * Math.min(1, dt * 10);

    // Advance (lng, lat) in meters
    const distanceMeters = baseSpeed * dt;
    const northMeters = Math.cos(moveHeadingRad) * distanceMeters;
    const eastMeters = Math.sin(moveHeadingRad) * distanceMeters;

    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos((state.lat * Math.PI) / 180);

    state.lat += northMeters / metersPerDegLat;
    state.lng += eastMeters / metersPerDegLng;
    state.totalDistanceMeters += distanceMeters;
    updateLiveOdometer(false);

    // Track step distance to spawn footstep rings & drawn map line
    state.stepDistanceAccum += distanceMeters;
    const strideLength = state.giantHeightMeters * 0.42;
    if (state.stepDistanceAccum >= strideLength) {
      state.stepDistanceAccum = 0;
      state.totalSteps += 1;
      layer.spawnFootstepRing(state.lng, state.lat);
      updateLiveOdometer(true);

      state.trailCoords.push([state.lng, state.lat]);
      updateTrailGeoJSON();
    }
  }

  // Handle Jumping (Spacebar)
  if (state.keys.space && state.altitudeMeters === 0) {
    state.verticalVelocity = state.giantHeightMeters * 0.95;
    layer.fadeToAction('Jump', 0.15);
  }

  if (state.altitudeMeters > 0 || state.verticalVelocity !== 0) {
    const gravity = state.giantHeightMeters * 2.4;
    state.altitudeMeters += state.verticalVelocity * dt;
    state.verticalVelocity -= gravity * dt;
    if (state.altitudeMeters <= 0) {
      state.altitudeMeters = 0;
      state.verticalVelocity = 0;
      layer.spawnFootstepRing(state.lng, state.lat);
    }
  }

  // Update Character Animation State
  if (state.altitudeMeters === 0) {
    if (isMoving) {
      layer.fadeToAction(isRunning ? 'Running' : 'Walking', 0.2);
    } else {
      layer.fadeToAction('Idle', 0.25);
    }
  }

  // Animate fallback procedural legs if GLTF hasn't finished loading yet
  if (layer.proceduralRig) {
    const t = performance.now() * 0.008 * (isRunning ? 1.8 : 1);
    const swing = isMoving ? Math.sin(t) * 0.45 : 0;
    layer.proceduralRig.leftLeg.rotation.x = swing;
    layer.proceduralRig.rightLeg.rotation.x = -swing;
  }

  // Update MapLibre Camera to match 3rd-Person or 1st-Person Giant POV
  syncCameraToGiant();
}

function getEndpointsGeoJSON() {
  const startCoord = state.trailCoords[0] || [state.lng, state.lat];
  const endCoord = state.trailCoords[state.trailCoords.length - 1] || [state.lng, state.lat];
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { role: 'start' },
        geometry: { type: 'Point', coordinates: startCoord },
      },
      {
        type: 'Feature',
        properties: { role: 'end' },
        geometry: { type: 'Point', coordinates: endCoord },
      },
    ],
  };
}

function updateTrailGeoJSON() {
  const trailSource = map.getSource('giant-trail');
  if (trailSource) {
    trailSource.setData({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: state.trailCoords,
      },
    });
  }

  const endpointsSource = map.getSource('giant-trail-endpoints');
  if (endpointsSource) {
    endpointsSource.setData(getEndpointsGeoJSON());
  }
}

function getTrashMapGeoJSON() {
  const features = [];

  // Active street trash items (acid-lime radar dots)
  for (const item of state.trashItems) {
    if (!item.collecting) {
      features.push({
        type: 'Feature',
        properties: { status: 'active' },
        geometry: { type: 'Point', coordinates: [item.lng, item.lat] },
      });
    }
  }

  // Cleaned-up trash spots along Crabby's route (hot-pink stars/dots)
  for (const coord of state.collectedTrashCoords) {
    features.push({
      type: 'Feature',
      properties: { status: 'cleaned' },
      geometry: { type: 'Point', coordinates: coord },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

function updateTrashMapGeoJSON() {
  const trashSource = map.getSource('trash-map-items');
  if (trashSource) {
    trashSource.setData(getTrashMapGeoJSON());
  }
}

function syncCameraToGiant() {
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos((state.lat * Math.PI) / 180);
  const bearingRad = (state.cameraBearing * Math.PI) / 180;

  // Scale zoom dynamically so the camera frames the giant proportionally to their height
  const heightRatio = state.giantHeightMeters / 65;

  if (state.cameraMode === 'third-person') {
    // Look slightly ahead of the giant so the character stands in the lower-third of the viewport
    const lookAheadMeters = 26 * heightRatio;
    const targetLat = state.lat + (Math.cos(bearingRad) * lookAheadMeters) / metersPerDegLat;
    const targetLng = state.lng + (Math.sin(bearingRad) * lookAheadMeters) / metersPerDegLng;
    const targetZoom = 17.25 - Math.log2(heightRatio);

    map.jumpTo({
      center: [targetLng, targetLat],
      zoom: targetZoom,
      pitch: state.cameraPitch,
      bearing: state.cameraBearing,
    });
  } else {
    // First-Person Giant Eye Level: shift focus ahead along gaze so street canyons open up below
    const eyeLookAheadMeters = 55 * heightRatio;
    const targetLat = state.lat + (Math.cos(bearingRad) * eyeLookAheadMeters) / metersPerDegLat;
    const targetLng = state.lng + (Math.sin(bearingRad) * eyeLookAheadMeters) / metersPerDegLng;
    const fpvZoom = 17.85 - Math.log2(heightRatio);

    map.jumpTo({
      center: [targetLng, targetLat],
      zoom: fpvZoom,
      pitch: state.cameraPitch,
      bearing: state.cameraBearing,
    });
  }
}

function normalizeAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

// ============================================================================
// 5. MAP LAYERS: NEO-ARCADE SYNTHWAVE, SATELLITE, 3D SKY & GIANT LAYER
// ============================================================================
let buildingLayerIds = [];
const originalLayerPaints = new Map();

const REALISTIC_BUILDING_COLOR = [
  'coalesce',
  ['get', 'colour'],
  [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'render_height'], 14],
    0, '#cfc8be',   // Low-rise warm stone / brick tone
    30, '#b9c0c9',  // Mid-rise architectural concrete
    90, '#8fa1b5',  // High-rise glass & steel
    220, '#6e859e', // Skyscraper reflective slate
  ],
];

const ARCADE_BUILDING_COLOR = [
  'interpolate',
  ['linear'],
  ['coalesce', ['get', 'render_height'], 14],
  0, '#2a124f',   // Low-rise deep arcade violet
  28, '#5a189a',  // Mid-rise electric purple
  75, '#b5179e',  // High-rise cyber magenta
  155, '#ff2a85', // Skyscraper hot pink
  250, '#e2ff00', // Supertall acid-lime crown
];

map.on('style.load', () => {
  // 1) Snapshot original vector layer paints & locate building / symbol layers
  const layers = map.getStyle().layers;
  let firstBuildingOrSymbolId = null;
  buildingLayerIds = [];
  originalLayerPaints.clear();

  for (const layer of layers) {
    const idLower = layer.id.toLowerCase();
    const sourceLayer = (layer['source-layer'] || '').toLowerCase();

    // Remove shop / restaurant / amenity POI circle icons from the map
    if (
      sourceLayer === 'poi' ||
      idLower.includes('poi') ||
      idLower.includes('shop') ||
      idLower.includes('amenity')
    ) {
      map.setLayoutProperty(layer.id, 'visibility', 'none');
      continue;
    }

    // Also hide any remaining symbol layer icons (e.g. transit/shield circles) while keeping street/place text
    if (layer.type === 'symbol' && layer.layout && layer.layout['icon-image']) {
      map.setPaintProperty(layer.id, 'icon-opacity', 0);
    }

    if (layer.type === 'fill-extrusion') {
      buildingLayerIds.push(layer.id);
      if (!firstBuildingOrSymbolId) firstBuildingOrSymbolId = layer.id;
    } else if (layer.type === 'symbol' && !firstBuildingOrSymbolId) {
      firstBuildingOrSymbolId = layer.id;
    }

    // Save original paint values so switching between Neo-Arcade and Realistic is seamless
    const saved = { type: layer.type };
    if (layer.type === 'background') {
      saved['background-color'] = map.getPaintProperty(layer.id, 'background-color');
    } else if (layer.type === 'fill') {
      saved['fill-color'] = map.getPaintProperty(layer.id, 'fill-color');
    } else if (layer.type === 'line') {
      saved['line-color'] = map.getPaintProperty(layer.id, 'line-color');
    } else if (layer.type === 'symbol') {
      saved['text-color'] = map.getPaintProperty(layer.id, 'text-color');
      saved['text-halo-color'] = map.getPaintProperty(layer.id, 'text-halo-color');
    }
    originalLayerPaints.set(layer.id, saved);
  }

  // 2) Add Free High-Res Satellite Aerial Imagery Source (Esri World Imagery)
  map.addSource('esri-world-imagery', {
    type: 'raster',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    tileSize: 256,
    maxzoom: 19,
    attribution: 'Tiles &copy; Esri',
  });

  map.addLayer(
    {
      id: 'satellite-ground',
      type: 'raster',
      source: 'esri-world-imagery',
      paint: {
        'raster-opacity': 1.0,
        'raster-contrast': 0.12,
        'raster-saturation': 0.08,
        'raster-brightness-min': 0.04,
      },
    },
    firstBuildingOrSymbolId || undefined
  );

  // 3) Enable vertical gradient shading on 3D buildings
  for (const bId of buildingLayerIds) {
    map.setPaintProperty(bId, 'fill-extrusion-vertical-gradient', true);
  }

  // 4) Add GeoJSON source & layers for the "Drawn Map" path
  // While walking, place these underneath the 3D buildings so buildings are prioritized at street level
  const beforeBuildingId = buildingLayerIds[0] || firstBuildingOrSymbolId || undefined;

  map.addSource('giant-trail', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: state.trailCoords,
      },
    },
  });

  map.addLayer(
    {
      id: 'giant-trail-glow',
      type: 'line',
      source: 'giant-trail',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': '#00a8ff',
        'line-width': 14,
        'line-opacity': 0.55,
        'line-blur': 5,
      },
    },
    beforeBuildingId
  );

  map.addLayer(
    {
      id: 'giant-trail-line',
      type: 'line',
      source: 'giant-trail',
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': '#00f0ff',
        'line-width': 5,
        'line-opacity': 1.0,
      },
    },
    beforeBuildingId
  );

  // Start & End markers for the drawn map
  map.addSource('giant-trail-endpoints', {
    type: 'geojson',
    data: getEndpointsGeoJSON(),
  });

  map.addLayer(
    {
      id: 'giant-trail-endpoints-layer',
      type: 'circle',
      source: 'giant-trail-endpoints',
      paint: {
        'circle-radius': [
          'match',
          ['get', 'role'],
          'start', 7,
          'end', 9,
          7,
        ],
        'circle-color': [
          'match',
          ['get', 'role'],
          'start', '#10b981',
          'end', '#00f0ff',
          '#00f0ff',
        ],
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#ffffff',
      },
    },
    beforeBuildingId
  );

  // Trash items & cleaned-up trash spots on the map
  map.addSource('trash-map-items', {
    type: 'geojson',
    data: getTrashMapGeoJSON(),
  });

  map.addLayer(
    {
      id: 'trash-map-items-layer',
      type: 'circle',
      source: 'trash-map-items',
      paint: {
        'circle-radius': [
          'match',
          ['get', 'status'],
          'cleaned', 6,
          'active', 5,
          5,
        ],
        'circle-color': [
          'match',
          ['get', 'status'],
          'cleaned', '#ff2a85',
          'active', '#e2ff00',
          '#e2ff00',
        ],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#090514',
      },
    },
    beforeBuildingId
  );

  // 5) Add the Three.js Giant Layer so it shares the 3D depth buffer with the extruded buildings
  if (buildingLayerIds.length > 0) {
    map.addLayer(giantLayer, buildingLayerIds[0]);
  } else {
    map.addLayer(giantLayer);
  }

  applyMapVisualMode(state.mapVisualMode);
});

function setTrailPriorityOverBuildings(prioritizeLine) {
  const trailLayerIds = [
    'giant-trail-glow',
    'giant-trail-line',
    'trash-map-items-layer',
    'giant-trail-endpoints-layer',
  ];
  const beforeId = prioritizeLine ? undefined : buildingLayerIds[0] || undefined;

  for (const id of trailLayerIds) {
    if (map.getLayer(id)) {
      map.moveLayer(id, beforeId);
    }
  }
}

function applyMapVisualMode(mode) {
  state.mapVisualMode = mode;
  document.body.classList.toggle('sketch-mode', mode === 'sketch');

  const isArcade = mode === 'arcade';

  // 1) Toggle Satellite Ground Imagery
  if (map.getLayer('satellite-ground')) {
    map.setLayoutProperty(
      'satellite-ground',
      'visibility',
      mode === 'satellite' ? 'visible' : 'none'
    );
  }

  // 2) Update 3D Sky Dome & Directional Lighting (Synthwave vs Daylight)
  if (typeof map.setSky === 'function') {
    if (isArcade) {
      map.setSky({
        'sky-color': '#0b041c',
        'sky-horizon-blend': 0.5,
        'horizon-color': '#ff2a85',
        'horizon-fog-blend': 0.65,
        'fog-color': '#240b4c',
        'fog-ground-blend': 0.4,
        'atmosphere-blend': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 0.9,
          18, 0.65,
        ],
      });
    } else {
      map.setSky({
        'sky-color': '#5882c1',
        'sky-horizon-blend': 0.45,
        'horizon-color': '#d8e4f2',
        'horizon-fog-blend': 0.55,
        'fog-color': '#cbd5e1',
        'fog-ground-blend': 0.35,
        'atmosphere-blend': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 0.85,
          18, 0.55,
        ],
      });
    }
  }

  if (typeof map.setLight === 'function') {
    map.setLight({
      anchor: 'map',
      color: isArcade ? '#ffd6f5' : '#fff8eb',
      intensity: isArcade ? 0.62 : 0.55,
      position: [1.35, 210, 38],
    });
  }

  // 3) Update 3D Buildings (Neo-Arcade Synthwave vs Realistic Architectural)
  const buildingOpacity = mode === 'satellite' ? 0.87 : 0.94;
  const buildingColor = isArcade ? ARCADE_BUILDING_COLOR : REALISTIC_BUILDING_COLOR;
  for (const bId of buildingLayerIds) {
    if (map.getLayer(bId)) {
      map.setPaintProperty(bId, 'fill-extrusion-opacity', buildingOpacity);
      map.setPaintProperty(bId, 'fill-extrusion-color', buildingColor);
    }
  }

  // 4) Restyle Base Vector Streets, Land, Water & Labels for Neo-Arcade Mode
  for (const [layerId, saved] of originalLayerPaints.entries()) {
    if (!map.getLayer(layerId)) continue;
    const idLower = layerId.toLowerCase();

    if (isArcade) {
      if (saved.type === 'background') {
        map.setPaintProperty(layerId, 'background-color', '#0d061f');
      } else if (saved.type === 'fill') {
        if (idLower.includes('water')) {
          map.setPaintProperty(layerId, 'fill-color', '#050210');
        } else if (
          idLower.includes('park') ||
          idLower.includes('grass') ||
          idLower.includes('wood') ||
          idLower.includes('green')
        ) {
          map.setPaintProperty(layerId, 'fill-color', '#0c2233');
        } else {
          map.setPaintProperty(layerId, 'fill-color', '#120929');
        }
      } else if (saved.type === 'line') {
        if (
          idLower.includes('motorway') ||
          idLower.includes('trunk') ||
          idLower.includes('primary')
        ) {
          map.setPaintProperty(layerId, 'line-color', '#ff2a85');
        } else if (
          idLower.includes('secondary') ||
          idLower.includes('tertiary') ||
          idLower.includes('street') ||
          idLower.includes('road') ||
          idLower.includes('Minor') ||
          idLower.includes('minor') ||
          idLower.includes('service') ||
          idLower.includes('path') ||
          idLower.includes('track')
        ) {
          map.setPaintProperty(layerId, 'line-color', '#6b21a8');
        } else if (idLower.includes('Case') || idLower.includes('case')) {
          map.setPaintProperty(layerId, 'line-color', '#240b4c');
        } else if (idLower.includes('rail') || idLower.includes('transit')) {
          map.setPaintProperty(layerId, 'line-color', '#9d4edd');
        }
      } else if (saved.type === 'symbol') {
        if (saved['text-color'] !== undefined) {
          map.setPaintProperty(layerId, 'text-color', '#e2ff00');
          map.setPaintProperty(layerId, 'text-halo-color', '#090514');
        }
      }
    } else {
      // Restore original vector layer colors
      if (saved.type === 'background' && saved['background-color'] !== undefined) {
        map.setPaintProperty(layerId, 'background-color', saved['background-color']);
      } else if (saved.type === 'fill' && saved['fill-color'] !== undefined) {
        map.setPaintProperty(layerId, 'fill-color', saved['fill-color']);
      } else if (saved.type === 'line' && saved['line-color'] !== undefined) {
        map.setPaintProperty(layerId, 'line-color', saved['line-color']);
      } else if (saved.type === 'symbol' && saved['text-color'] !== undefined) {
        map.setPaintProperty(layerId, 'text-color', saved['text-color']);
        if (saved['text-halo-color'] !== undefined) {
          map.setPaintProperty(layerId, 'text-halo-color', saved['text-halo-color']);
        }
      }
    }
  }
}

// ============================================================================
// 6. INPUT LISTENERS (Keyboard, Mouse Look & HUD Controls)
// ============================================================================
function setKeycapPressed(keyName, isPressed) {
  const kbd = document.querySelector(`kbd[data-key="${keyName}"]`);
  if (kbd) {
    kbd.classList.toggle('pressed', isPressed);
  }
}

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'w' || e.key === 'ArrowUp') {
    state.keys.w = true;
    setKeycapPressed('w', true);
  }
  if (key === 's' || e.key === 'ArrowDown') {
    state.keys.s = true;
    setKeycapPressed('s', true);
  }
  if (key === 'a' || e.key === 'ArrowLeft') {
    state.keys.a = true;
    setKeycapPressed('a', true);
  }
  if (key === 'd' || e.key === 'ArrowRight') {
    state.keys.d = true;
    setKeycapPressed('d', true);
  }
  if (key === 'q') {
    state.keys.q = true;
    setKeycapPressed('q', true);
  }
  if (key === 'e') {
    state.keys.e = true;
    setKeycapPressed('e', true);
  }
  if (e.key === 'Shift') {
    state.keys.shift = true;
    setKeycapPressed('shift', true);
  }
  if (e.code === 'Space') {
    state.keys.space = true;
    setKeycapPressed('space', true);
    e.preventDefault();
  }
  if (key === 'v') {
    setKeycapPressed('v', true);
    toggleCameraMode();
  }
  if (key === 'c') {
    setKeycapPressed('c', true);
    toggleDrawnTrail();
  }
});

window.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'w' || e.key === 'ArrowUp') {
    state.keys.w = false;
    setKeycapPressed('w', false);
  }
  if (key === 's' || e.key === 'ArrowDown') {
    state.keys.s = false;
    setKeycapPressed('s', false);
  }
  if (key === 'a' || e.key === 'ArrowLeft') {
    state.keys.a = false;
    setKeycapPressed('a', false);
  }
  if (key === 'd' || e.key === 'ArrowRight') {
    state.keys.d = false;
    setKeycapPressed('d', false);
  }
  if (key === 'q') {
    state.keys.q = false;
    setKeycapPressed('q', false);
  }
  if (key === 'e') {
    state.keys.e = false;
    setKeycapPressed('e', false);
  }
  if (e.key === 'Shift') {
    state.keys.shift = false;
    setKeycapPressed('shift', false);
  }
  if (e.code === 'Space') {
    state.keys.space = false;
    setKeycapPressed('space', false);
  }
  if (key === 'v') setKeycapPressed('v', false);
  if (key === 'c') setKeycapPressed('c', false);
});

// Mouse drag to look around the streets and rooftops (when walking)
let isDragging = false;
let prevMouse = { x: 0, y: 0 };

const mapCanvas = map.getCanvasContainer();
mapCanvas.addEventListener('mousedown', (e) => {
  if (state.walkEnded) return;
  if (e.button === 0) {
    isDragging = true;
    prevMouse = { x: e.clientX, y: e.clientY };
  }
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging || state.walkEnded) return;
  const dx = e.clientX - prevMouse.x;
  const dy = e.clientY - prevMouse.y;
  prevMouse = { x: e.clientX, y: e.clientY };

  state.cameraBearing += dx * 0.32;
  state.cameraPitch = Math.max(25, Math.min(84, state.cameraPitch - dy * 0.25));
});

window.addEventListener('mouseup', () => {
  isDragging = false;
});

// HUD UI Controls
const citySelect = document.getElementById('city-select');
const heightSlider = document.getElementById('height-slider');
const heightVal = document.getElementById('height-val');
const fpvEyeHeight = document.getElementById('fpv-eye-height');
const cameraBtn = document.getElementById('camera-btn');
const styleBtn = document.getElementById('style-btn');
const endWalkBtn = document.getElementById('end-walk-btn');
const aerialBanner = document.getElementById('aerial-banner');
const aerialStats = document.getElementById('aerial-stats');
const fpvOverlay = document.getElementById('fpv-overlay');
const liveStepsEl = document.getElementById('live-steps');
const liveDistEl = document.getElementById('live-dist');
const liveTrashEl = document.getElementById('live-trash');
const pickupToastEl = document.getElementById('pickup-toast');
let toastTimeout = null;

function onTrashPickedUp(item) {
  if (liveTrashEl) {
    liveTrashEl.textContent = `${state.trashCollected}`;
    liveTrashEl.classList.add('bump');
    setTimeout(() => liveTrashEl.classList.remove('bump'), 180);
  }

  if (pickupToastEl) {
    pickupToastEl.textContent = `🦀 +1 ${item.label}! (${state.trashCollected} CLEANED)`;
    pickupToastEl.classList.remove('hidden');
    // Restart pop animation
    pickupToastEl.style.animation = 'none';
    void pickupToastEl.offsetWidth;
    pickupToastEl.style.animation = '';

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      pickupToastEl.classList.add('hidden');
    }, 1600);
  }
}

function updateLiveOdometer(didStep) {
  if (liveTrashEl) {
    liveTrashEl.textContent = `${state.trashCollected}`;
  }
  if (liveStepsEl) {
    liveStepsEl.textContent = `${state.totalSteps}`;
    if (didStep) {
      liveStepsEl.classList.add('bump');
      setTimeout(() => liveStepsEl.classList.remove('bump'), 140);
    }
  }
  if (liveDistEl) {
    liveDistEl.textContent =
      state.totalDistanceMeters >= 1000
        ? `${(state.totalDistanceMeters / 1000).toFixed(2)}km`
        : `${Math.round(state.totalDistanceMeters)}m`;
  }
}

citySelect.addEventListener('change', (e) => {
  const [lngStr, latStr] = e.target.value.split(',');
  state.lng = parseFloat(lngStr);
  state.lat = parseFloat(latStr);
  state.trailCoords = [[state.lng, state.lat]];
  state.totalDistanceMeters = 0;
  state.totalSteps = 0;
  state.trashCollected = 0;
  state.collectedTrashCoords = [];
  updateLiveOdometer(false);
  state.footprints.forEach((fp) => giantLayer.footprintsGroup.remove(fp.mesh));
  state.footprints = [];
  giantLayer.spawnTrashCluster(state.lng, state.lat, 24);

  if (state.walkEnded) {
    toggleEndWalk(); // Return to active walk mode in the new city
  }

  updateTrailGeoJSON();
  citySelect.blur();
});

heightSlider.addEventListener('input', (e) => {
  state.giantHeightMeters = parseFloat(e.target.value);
  heightVal.textContent = `${state.giantHeightMeters}m`;
  fpvEyeHeight.textContent = `${Math.round(state.giantHeightMeters * 0.92)}m`;
});

function toggleCameraMode() {
  if (state.walkEnded) return;
  state.cameraMode =
    state.cameraMode === 'third-person' ? 'first-person' : 'third-person';
  const isFpv = state.cameraMode === 'first-person';
  cameraBtn.textContent = isFpv
    ? 'Camera: 1st Person (V)'
    : 'Camera: 3rd Person (V)';
  fpvOverlay.classList.toggle('hidden', !isFpv);
  fpvEyeHeight.textContent = `${Math.round(state.giantHeightMeters * 0.92)}m`;
}

function toggleDrawnTrail() {
  state.drawTrail = !state.drawTrail;
  const visibility = state.drawTrail ? 'visible' : 'none';
  if (map.getLayer('giant-trail-line')) {
    map.setLayoutProperty('giant-trail-line', 'visibility', visibility);
    map.setLayoutProperty('giant-trail-glow', 'visibility', visibility);
    map.setLayoutProperty('giant-trail-endpoints-layer', 'visibility', visibility);
  }
}

function toggleEndWalk() {
  state.walkEnded = !state.walkEnded;

  if (state.walkEnded) {
    // 1) Stop movement keys & ensure current giant position is the final point of the drawn map
    Object.keys(state.keys).forEach((k) => {
      state.keys[k] = false;
    });
    const lastCoord = state.trailCoords[state.trailCoords.length - 1];
    if (!lastCoord || lastCoord[0] !== state.lng || lastCoord[1] !== state.lat) {
      state.trailCoords.push([state.lng, state.lat]);
    }
    updateTrailGeoJSON();

    // 2) Prioritize the neon blue trail OVER buildings in Aerial End Walk mode
    setTrailPriorityOverBuildings(true);
    state.drawTrail = true;
    if (map.getLayer('giant-trail-line')) {
      map.setLayoutProperty('giant-trail-line', 'visibility', 'visible');
      map.setLayoutProperty('giant-trail-glow', 'visibility', 'visible');
      map.setLayoutProperty('giant-trail-endpoints-layer', 'visibility', 'visible');
      map.setPaintProperty('giant-trail-line', 'line-width', 7);
      map.setPaintProperty('giant-trail-glow', 'line-width', 20);
      map.setPaintProperty('giant-trail-glow', 'line-opacity', 0.7);
    }

    // 3) Hide first-person overlay & enable free map pan/zoom so user can inspect their map
    fpvOverlay.classList.add('hidden');
    map.dragPan.enable();

    // 4) Update UI banner & button state
    endWalkBtn.textContent = '⚡ RESUME WALK ⚡';
    endWalkBtn.classList.add('active');
    const distFormatted =
      state.totalDistanceMeters >= 1000
        ? `${(state.totalDistanceMeters / 1000).toFixed(2)} km`
        : `${Math.round(state.totalDistanceMeters)} m`;
    aerialStats.textContent = `${state.trashCollected} trash cleaned • ${state.totalSteps} steps • ${distFormatted}`;
    aerialBanner.classList.remove('hidden');

    // 5) Fly to top-down Aerial View framing the entire path drawn on the map
    if (state.trailCoords.length > 1) {
      const bounds = new maplibregl.LngLatBounds(
        state.trailCoords[0],
        state.trailCoords[0]
      );
      for (const coord of state.trailCoords) {
        bounds.extend(coord);
      }
      map.fitBounds(bounds, {
        padding: { top: 120, bottom: 120, left: 380, right: 120 },
        pitch: 0,
        bearing: 0,
        maxZoom: 17.2,
        duration: 2200,
      });
    } else {
      map.flyTo({
        center: [state.lng, state.lat],
        zoom: 15.8,
        pitch: 0,
        bearing: 0,
        duration: 2000,
      });
    }
  } else {
    // Resume Walk: re-lock camera to the giant & prioritize 3D buildings over the trail
    setTrailPriorityOverBuildings(false);
    map.dragPan.disable();
    endWalkBtn.textContent = '★ END WALK & VIEW MAP ★';
    endWalkBtn.classList.remove('active');
    aerialBanner.classList.add('hidden');
    fpvOverlay.classList.toggle('hidden', state.cameraMode !== 'first-person');

    if (map.getLayer('giant-trail-line')) {
      map.setPaintProperty('giant-trail-line', 'line-width', 5);
      map.setPaintProperty('giant-trail-glow', 'line-width', 14);
      map.setPaintProperty('giant-trail-glow', 'line-opacity', 0.55);
    }

    syncCameraToGiant();
  }
}

cameraBtn.addEventListener('click', toggleCameraMode);
endWalkBtn.addEventListener('click', toggleEndWalk);

styleBtn.addEventListener('click', () => {
  const modes = ['arcade', 'satellite', 'vector', 'sketch'];
  const labels = {
    arcade: 'Style: Neo-Arcade 3D',
    satellite: 'Style: Satellite 3D',
    vector: 'Style: Vector 3D',
    sketch: 'Style: Sketch / Ink',
  };
  const nextIndex = (modes.indexOf(state.mapVisualMode) + 1) % modes.length;
  const nextMode = modes[nextIndex];
  applyMapVisualMode(nextMode);
  styleBtn.textContent = labels[nextMode];
});
