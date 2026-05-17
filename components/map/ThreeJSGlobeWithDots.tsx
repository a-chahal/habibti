"use client";

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ConicPolygonGeometry from 'three-conic-polygon-geometry';
import { useMapStore } from '@/lib/stores/mapStore';

interface GeoJSONFeature {
  geometry: {
    type: 'Polygon' | 'MultiPolygon' | 'LineString' | 'MultiLineString';
    coordinates: any;
  };
  properties?: Record<string, any>;
}

interface GlobeRoute {
  arcId?: string;
  optionId?: string;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  color?: string;
  opacity?: number;
}

interface GlobeMarker {
  id: string;
  lat: number;
  lon: number;
  color: string;
  size?: number;
  pulsing?: boolean;
}

interface GlobeProps {
  routes?: GlobeRoute[];
  arcHeightMultiplier?: number;
  routeThickness?: number;
  markers?: GlobeMarker[];
  onArcClick?: (optionId: string, arcId: string) => void;
}

export default function ThreeJSGlobeWithDots({
  routes = [],
  arcHeightMultiplier = 0.4,
  routeThickness = 0.005,
  markers = [],
  onArcClick,
}: GlobeProps) {
  const onArcClickRef = useRef(onArcClick);
  useEffect(() => { onArcClickRef.current = onArcClick; }, [onArcClick]);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const globeGroupRef = useRef<THREE.Group | null>(null);

  // spinBoostRef  = target speed multiplier (driven by Zustand store)
  // currentSpinRef = actual speed used in animate loop (lerps toward target)
  // Reading via ref avoids re-mounting the Three.js scene on store changes.
  const spinBoostRef = useRef<number>(1);
  const currentSpinRef = useRef<number>(1);
  useEffect(() => {
    const unsub = useMapStore.subscribe((state) => {
      spinBoostRef.current = state.globeSpinBoost;
    });
    spinBoostRef.current = useMapStore.getState().globeSpinBoost;
    currentSpinRef.current = spinBoostRef.current;
    return unsub;
  }, []);

  useEffect(() => {
    if (!mountRef.current) return;

    const width = mountRef.current.clientWidth;
    const height = mountRef.current.clientHeight;

    // 1. Scene bootstrapping
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mountRef.current.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    camera.position.z = 3.5;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.minDistance = 2;
    controls.maxDistance = 6;

    let isDragging = false;
    let resumeRotationTimeout: NodeJS.Timeout;
    let autoRotate = true;

    controls.addEventListener('start', () => {
      isDragging = true;
      autoRotate = false;
      clearTimeout(resumeRotationTimeout);
    });

    controls.addEventListener('end', () => {
      isDragging = false;
      resumeRotationTimeout = setTimeout(() => {
        if (!isDragging) {
          autoRotate = true;
        }
      }, 3000);
    });

    const globeGroup = new THREE.Group();
    scene.add(globeGroup);
    globeGroupRef.current = globeGroup;

    // Groups for zooming elements
    const statesGroup = new THREE.Group();
    statesGroup.visible = false;
    globeGroup.add(statesGroup);

    const citiesGroup = new THREE.Group();
    citiesGroup.visible = false;
    globeGroup.add(citiesGroup);

    let statesMaterialRef: THREE.LineBasicMaterial | null = null;
    let citiesMaterialRef: THREE.PointsMaterial | null = null;

    // 2. Wireframe sphere (using Icosahedron for the triangular geodesic look)
    const R = 1.3;
    const sphereGeo = new THREE.IcosahedronGeometry(R, 40);
    const sphereMat = new THREE.MeshBasicMaterial({
      wireframe: true,
      opacity: 0.15,
      color: '#ffffff',
      transparent: true
    });
    const wireframeSphere = new THREE.Mesh(sphereGeo, sphereMat);
    globeGroup.add(wireframeSphere);

    // 4. Continent / Country geometry
    fetch('/countries.geojson')
      .then(res => res.json())
      .then(geoJson => {
        const continentMat = new THREE.LineBasicMaterial({ color: '#ffffff', opacity: 0.85, transparent: true });
        const fillMat = new THREE.MeshBasicMaterial({
          color: '#1a1a1a', // Dark opaque color
          opacity: 1,
          transparent: false,
          depthWrite: true,
          side: THREE.DoubleSide
        });

        geoJson.features.forEach((feature: GeoJSONFeature) => {
          const polygons = feature.geometry.type === 'Polygon'
            ? [feature.geometry.coordinates]
            : feature.geometry.coordinates;

          polygons.forEach((polygon: number[][][]) => {
            // Fill using ConicPolygonGeometry
            const conicGeo = new ConicPolygonGeometry(polygon, R, R + 0.015, false, true, false, 5);
            const fillMesh = new THREE.Mesh(conicGeo, fillMat);
            // Attach ADM0_A3 for raycasting focus detection
            fillMesh.userData = { countryCode: feature.properties?.ADM0_A3 };
            globeGroup.add(fillMesh);

            // Outlines
            polygon.forEach((ring: number[][]) => {
              const points: THREE.Vector3[] = [];
              ring.forEach((coord: number[]) => {
                const [lon, lat] = coord;
                const phi = (90 - lat) * Math.PI / 180;
                const theta = (90 - lon) * Math.PI / 180;

                const rOutline = R + 0.016;
                const x = rOutline * Math.sin(phi) * Math.cos(theta);
                const y = rOutline * Math.cos(phi);
                const z = rOutline * Math.sin(phi) * Math.sin(theta);
                points.push(new THREE.Vector3(x, y, z));
              });

              const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
              const line = new THREE.Line(lineGeo, continentMat);
              globeGroup.add(line);
            });
          });
        });
      })
      .catch(err => console.error("Error loading continents:", err));

    // 5. Dynamic States Rendering Variables
    const stateMat = new THREE.LineBasicMaterial({ color: '#ffffff', opacity: 0, transparent: true });
    statesMaterialRef = stateMat;

    let currentFocusedCountry: string | null = null;
    const statesCache = new Map<string, THREE.Vector3[]>();
    let isFetchingStates = false;

    const loadCountryStates = async (countryCode: string) => {
      if (isFetchingStates || !countryCode) return;
      currentFocusedCountry = countryCode;

      let allStatePoints = statesCache.get(countryCode);

      if (!allStatePoints) {
        isFetchingStates = true;
        try {
          const res = await fetch(`/api/states?country=${countryCode}`);
          const geoJson = await res.json();
          allStatePoints = [];

          if (geoJson.features) {
            geoJson.features.forEach((feature: GeoJSONFeature) => {
              if (!feature.geometry) return;
              const type = feature.geometry.type;
              const coords = type === 'MultiLineString' ? feature.geometry.coordinates : (type === 'LineString' ? [feature.geometry.coordinates] : []);

              coords.forEach((lineString: number[][]) => {
                for (let i = 0; i < lineString.length - 1; i++) {
                  const [lon1, lat1] = lineString[i];
                  const [lon2, lat2] = lineString[i + 1];

                  const phi1 = (90 - lat1) * Math.PI / 180;
                  const theta1 = (90 - lon1) * Math.PI / 180;
                  const phi2 = (90 - lat2) * Math.PI / 180;
                  const theta2 = (90 - lon2) * Math.PI / 180;

                  const rOutline = R + 0.016;

                  allStatePoints!.push(
                    new THREE.Vector3(
                      rOutline * Math.sin(phi1) * Math.cos(theta1),
                      rOutline * Math.cos(phi1),
                      rOutline * Math.sin(phi1) * Math.sin(theta1)
                    ),
                    new THREE.Vector3(
                      rOutline * Math.sin(phi2) * Math.cos(theta2),
                      rOutline * Math.cos(phi2),
                      rOutline * Math.sin(phi2) * Math.sin(theta2)
                    )
                  );
                }
              });
            });
          }
          statesCache.set(countryCode, allStatePoints);
        } catch (err) {
          console.error("Error loading states for", countryCode, err);
        } finally {
          isFetchingStates = false;
        }
      }

      // If user zoomed out or changed focus quickly, abort updating
      if (currentFocusedCountry !== countryCode) return;

      // Update the states mesh
      while (statesGroup.children.length > 0) {
        const child = statesGroup.children[0] as THREE.LineSegments;
        statesGroup.remove(child);
        if (child.geometry) child.geometry.dispose();
      }

      if (allStatePoints && allStatePoints.length > 0) {
        const mergedGeo = new THREE.BufferGeometry().setFromPoints(allStatePoints);
        const mergedLines = new THREE.LineSegments(mergedGeo, stateMat);
        statesGroup.add(mergedLines);
      }
    };

    // 6. Cities data (Points)
    fetch('/cities_lite.json')
      .then(res => res.json())
      .then((cities: number[][]) => {
        const vertices = [];
        for (let i = 0; i < cities.length; i++) {
          const [lat, lon] = cities[i];
          const phi = (90 - lat) * Math.PI / 180;
          const theta = (90 - lon) * Math.PI / 180;
          const rCity = R + 0.017;
          vertices.push(
            rCity * Math.sin(phi) * Math.cos(theta),
            rCity * Math.cos(phi),
            rCity * Math.sin(phi) * Math.sin(theta)
          );
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

        const material = new THREE.PointsMaterial({
          color: '#00ffff',
          size: 0.005,
          transparent: true,
          opacity: 0,
          sizeAttenuation: true
        });
        citiesMaterialRef = material;

        const pointsMesh = new THREE.Points(geometry, material);
        citiesGroup.add(pointsMesh);
      })
      .catch(err => console.error("Error loading cities:", err));

    // 7. Globe group rotation & animate loop
    let animationFrameId: number;

    const STATE_THRESHOLD = 4.0;
    const CITY_THRESHOLD = 2.8;

    const raycaster = new THREE.Raycaster();
    const screenCenter = new THREE.Vector2(0, 0);
    let frameCount = 0;

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);

      controls.update();

      if (autoRotate) {
        // Lerp toward target: fast ramp-up (0.08), slow exponential ramp-down (0.012)
        const spinTarget = spinBoostRef.current;
        const lerpFactor = currentSpinRef.current < spinTarget ? 0.08 : 0.012;
        currentSpinRef.current += (spinTarget - currentSpinRef.current) * lerpFactor;

        globeGroup.rotation.y += 0.003 * currentSpinRef.current;
        // Elegant cosmic figure-8 tilting over two full horizontal rotation cycles (4 * Math.PI)
        const theta = globeGroup.rotation.y;
        const maxTilt = 0.15; // Subtle and extremely premium 8.5-degree wobble
        globeGroup.rotation.x = maxTilt * Math.sin(theta / 2);
        globeGroup.rotation.z = maxTilt * Math.sin(theta);
      } else {
        // Smoothly return axis tilts back to level during manual orbit controls interaction
        globeGroup.rotation.x += (0 - globeGroup.rotation.x) * 0.08;
        globeGroup.rotation.z += (0 - globeGroup.rotation.z) * 0.08;
      }

      const distance = camera.position.length();

      // Focus Country Raycasting (every 10 frames to save CPU)
      if (distance < STATE_THRESHOLD && frameCount % 10 === 0) {
        raycaster.setFromCamera(screenCenter, camera);
        const intersects = raycaster.intersectObject(globeGroup, true);
        const countryHit = intersects.find(hit => hit.object.userData && hit.object.userData.countryCode);

        if (countryHit) {
          const hitCountryCode = countryHit.object.userData.countryCode;
          if (hitCountryCode !== currentFocusedCountry) {
             loadCountryStates(hitCountryCode);
          }
        }
      }
      frameCount++;

      // Fade states
      if (statesMaterialRef) {
        if (distance < STATE_THRESHOLD) {
          statesGroup.visible = true;
          // Target max opacity 0.3
          const targetOpacity = Math.min(0.3, Math.max(0, (STATE_THRESHOLD - distance) / 0.5 * 0.3));
          statesMaterialRef.opacity += (targetOpacity - statesMaterialRef.opacity) * 0.1;
        } else {
          statesMaterialRef.opacity += (0 - statesMaterialRef.opacity) * 0.1;
          if (statesMaterialRef.opacity < 0.01) statesGroup.visible = false;
        }
      }

      // Fade cities
      if (citiesMaterialRef) {
        if (distance < CITY_THRESHOLD) {
          citiesGroup.visible = true;
          // Target max opacity 0.6
          const targetOpacity = Math.min(0.6, Math.max(0, (CITY_THRESHOLD - distance) / 0.5 * 0.6));
          citiesMaterialRef.opacity += (targetOpacity - citiesMaterialRef.opacity) * 0.1;
        } else {
          citiesMaterialRef.opacity += (0 - citiesMaterialRef.opacity) * 0.1;
          if (citiesMaterialRef.opacity < 0.01) citiesGroup.visible = false;
        }
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    // Arc click handling — with drag-detection guard so globe rotation doesn't trigger clicks
    let mouseDownX = 0;
    let mouseDownY = 0;

    const onMouseDown = (e: MouseEvent) => {
      mouseDownX = e.clientX;
      mouseDownY = e.clientY;
    };

    const onCanvasClick = (e: MouseEvent) => {
      if (!mountRef.current || !onArcClickRef.current) return;
      const dx = e.clientX - mouseDownX;
      const dy = e.clientY - mouseDownY;
      if (Math.hypot(dx, dy) > 6) return; // was a drag, not a tap

      const rect = mountRef.current.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      const mouse = new THREE.Vector2(x, y);
      const clickRay = new THREE.Raycaster();
      clickRay.setFromCamera(mouse, camera);

      const hits = clickRay.intersectObjects(routeMeshesRef.current, false);
      if (hits.length > 0) {
        const { optionId, arcId } = hits[0].object.userData as { optionId?: string; arcId?: string };
        if (onArcClickRef.current) {
          onArcClickRef.current(optionId ?? "", arcId ?? "");
        }
      }
    };

    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('click', onCanvasClick);

    // Store ref values to clean up properly
    const currentMount = mountRef.current;

    return () => {
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('mousedown', onMouseDown);
      renderer.domElement.removeEventListener('click', onCanvasClick);
      cancelAnimationFrame(animationFrameId);
      controls.dispose();
      renderer.dispose();
      clearTimeout(resumeRotationTimeout);
      if (currentMount && renderer.domElement) {
        currentMount.removeChild(renderer.domElement);
      }
    };
  }, []);

  // Handle Route Drawing
  const routeMeshesRef = useRef<THREE.Mesh[]>([]);

  useEffect(() => {
    if (!globeGroupRef.current) return;
    const group = globeGroupRef.current;

    // Cleanup previous routes
    routeMeshesRef.current.forEach(mesh => {
      group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    routeMeshesRef.current = [];

    if (!routes || routes.length === 0) return;

    const R = 1.3;
    const getCartesian = (lat: number, lon: number, radius: number) => {
      const phi = (90 - lat) * Math.PI / 180;
      const theta = (90 - lon) * Math.PI / 180;
      return new THREE.Vector3(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta)
      );
    };

    routes.forEach(route => {
      const p1 = getCartesian(route.lat1, route.lon1, R);
      const p2 = getCartesian(route.lat2, route.lon2, R);

      const distance = p1.distanceTo(p2);
      const arcHeight = distance * arcHeightMultiplier;

      const points: THREE.Vector3[] = [];
      const numPoints = 64;

      for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        const pt = new THREE.Vector3().copy(p1).lerp(p2, t);
        pt.normalize();

        const currentHeight = R + 0.01 + arcHeight * (4 * t * (1 - t));
        pt.multiplyScalar(currentHeight);

        points.push(pt);
      }

      const arcOpacity = route.opacity ?? 0.9;
      const curve = new THREE.CatmullRomCurve3(points);
      const geometry = new THREE.TubeGeometry(curve, 64, routeThickness, 8, false);
      const material = new THREE.MeshBasicMaterial({
        color: route.color ?? '#ffffff',
        transparent: true,
        opacity: arcOpacity,
      });

      const routeMesh = new THREE.Mesh(geometry, material);
      // Store identifiers for click raycasting
      routeMesh.userData = {
        arcId: route.arcId ?? null,
        optionId: route.optionId ?? null,
      };
      group.add(routeMesh);
      routeMeshesRef.current.push(routeMesh);
    });

  }, [routes, arcHeightMultiplier, routeThickness]);

  // Handle Markers (additive — does not touch route/wireframe/country/city code)
  const markerMeshesRef = useRef<THREE.Mesh[]>([]);
  const pulseFrameRef = useRef(0);
  const animFrameRef = useRef<number>(0);

  useEffect(() => {
    if (!globeGroupRef.current) return;
    const group = globeGroupRef.current;

    markerMeshesRef.current.forEach(mesh => {
      group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    markerMeshesRef.current = [];
    cancelAnimationFrame(animFrameRef.current);

    if (!markers || markers.length === 0) return;

    const R = 1.3;

    markers.forEach(marker => {
      const phi = (90 - marker.lat) * Math.PI / 180;
      const theta = (90 - marker.lon) * Math.PI / 180;
      const rMarker = R + 0.02;

      const x = rMarker * Math.sin(phi) * Math.cos(theta);
      const y = rMarker * Math.cos(phi);
      const z = rMarker * Math.sin(phi) * Math.sin(theta);

      const size = marker.size ?? 0.018;
      const geo = new THREE.SphereGeometry(size, 12, 12);
      const mat = new THREE.MeshBasicMaterial({ color: marker.color, transparent: true, opacity: 0.95 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.userData.pulsing = marker.pulsing ?? false;
      group.add(mesh);
      markerMeshesRef.current.push(mesh);
    });

    // Pulse animation for vessel marker
    const pulsingMeshes = markerMeshesRef.current.filter(m => m.userData.pulsing);
    if (pulsingMeshes.length === 0) return;

    const animatePulse = () => {
      animFrameRef.current = requestAnimationFrame(animatePulse);
      pulseFrameRef.current += 0.05;
      const scale = 1 + 0.3 * Math.sin(pulseFrameRef.current);
      pulsingMeshes.forEach(m => m.scale.setScalar(scale));
    };
    animatePulse();

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [markers]);

  return (
    <div className="relative w-full h-full bg-[#0a0a0a] overflow-hidden">
      <div ref={mountRef} className="absolute inset-0 cursor-grab active:cursor-grabbing" />
    </div>
  );
}
