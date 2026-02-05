
import * as THREE from "https://unpkg.com/three@0.165.0/build/three.module.js";

// WebXR AR support check
async function supportsAR() {
    if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
    try {
    return await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
    return false;
    }
}
// Initialize the AR session
(async function init() {
    // Get the buttons and elements
    const enterARButton = document.getElementById("enter-ar");
    const unsupportedEl = document.getElementById("unsupported");
    const placementToggleButton = document.getElementById("placement-toggle"); // Toggle placement mode
    const instructionsEl = document.getElementById("instructions"); // Instructions
    const centerReticleEl = document.getElementById("center-reticle"); // Center reticle

    // Check if the browser/device supports AR
    if (!(await supportsAR())) {
    enterARButton.style.display = "none";
    unsupportedEl.style.display = "flex";
    return;
    }

    // Initialize the renderer, scene, and camera
    let renderer, scene, camera;
    let xrSession = null;
    let referenceSpace = null;
    let hitTestSource = null;
    let hitTestSourceRequested = false;
    let reticle = null;
    let placedPlane = null;
    let planeAnchor = null; // XRAnchor if available
    let planeOrientationOffset = null; // Align PlaneGeometry with detected surface
    let placementMode = true; // If false: no reticle + taps don't move plane
    let mapTexture = null; // Shared texture for reticle + placed plane
    let blockNextSelect = false; // Prevent UI taps from placing/moving plane

    // Event markers
    const eventMarkers = [];
    const allEvents = [];
    let eventsLoaded = false;
    let activeEventDate = null;
    let availableEventDates = [];
    const roadMeshes = [];
    let roadsLoaded = false;

    // Map image bounds in WGS84 (lat, lon). Used by projectToMapSurface().
    const mapCorners = {
    topLeft: [58.635427, 16.119594],
    topRight: [58.633813, 16.291792],
    bottomRight: [58.544023, 16.288487],
    bottomLeft: [58.545631, 16.116729]
    };

    const overlayRotationY = Math.PI / 2;

    // Setup the three.js renderer, scene, and camera
    function setupThree() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    document.body.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.7);
    dirLight.position.set(0.5, 1, 0.5);
    scene.add(dirLight);

    const textureLoader = new THREE.TextureLoader();
    textureLoader.load(
        "nrkpg-map.png",
        (tex) => {
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        mapTexture = tex;
        if (reticle && reticle.material) { reticle.material.map = mapTexture; reticle.material.needsUpdate = true; }
        if (placedPlane && placedPlane.material) { placedPlane.material.map = mapTexture; placedPlane.material.needsUpdate = true; }
        },
        undefined,
        (err) => console.warn("Failed to load nrkpg-map.png texture", err)
    );

    reticle = new THREE.Mesh(
        new THREE.PlaneGeometry(0.4, 0.4),
        new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: mapTexture || null,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6
        })
    );
    reticle.visible = false;
    scene.add(reticle);

    planeOrientationOffset = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-Math.PI / 2, 0, 0)
    );

    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
    }

    // Start the AR session
    async function startAR() {
    if (!renderer) setupThree();

    xrSession = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["anchors", "local-floor", "dom-overlay"],
        domOverlay: { root: document.body }
    });

    xrSession.addEventListener("end", () => {
        xrSession = null;
        hitTestSourceRequested = false;
        hitTestSource = null;
        planeAnchor = null;
        // End the session
        if (renderer && renderer.xr) renderer.xr.setSession(null);

        enterARButton.style.display = "block";
        // Hide the buttons
        placementToggleButton.style.display = "none";
        centerReticleEl.style.display = "none";
        // Update the instructions
        instructionsEl.textContent = 'Tap "Enter AR" to start, then move your phone to find a surface.';
    });

    // Set the reference space type
    renderer.xr.setReferenceSpaceType("local-floor");
    // Set the session
    await renderer.xr.setSession(xrSession);
    referenceSpace = await xrSession.requestReferenceSpace("local-floor");

    // Request an animation frame
    xrSession.requestAnimationFrame(onXRFrame);

    // Show the buttons
    enterARButton.style.display = "none";
    placementToggleButton.style.display = "block";
    centerReticleEl.style.display = "block";

    // Set the placement mode
    placementMode = true;
    // Update the placement toggle button text
    placementToggleButton.textContent = "Placement: ON";
    instructionsEl.textContent = "Placement mode: ON – move to find a surface, then tap to place a plane.";

    // On select event
    const onSelect = (event) => {
        if (blockNextSelect) { blockNextSelect = false; return; }

        const frame = event.frame;
        // Check if the frame, hit test source, and reference space are valid
        if (!frame || !hitTestSource || !referenceSpace) return;

        const hitTestResults = frame.getHitTestResults(hitTestSource);
        // Check if the hit test results are valid
        if (hitTestResults.length === 0) return;

        const hit = hitTestResults[0];
        const pose = hit.getPose(referenceSpace);
        if (!pose) return;

        if (placementMode) {

        if (xrSession.requestAnchor) {
            // Request an anchor, then place or move the plane from the pose
            xrSession.requestAnchor(pose.transform, referenceSpace)
            .then((anchor) => {
                // Set the plane anchor
                planeAnchor = anchor;
                // Place or move the plane from the pose
                placeOrMovePlaneFromPose(pose);
                anchor.context = { threeObject: placedPlane };
                anchor.addEventListener("remove", () => { planeAnchor = null; });
            })
            .catch(() => {
                planeAnchor = null;
                placeOrMovePlaneFromPose(pose);
            });
        } else {
            // Set the plane anchor to null
            planeAnchor = null;
            // Place or move the plane from the pose
            placeOrMovePlaneFromPose(pose);
        }
        }
    };

    xrSession.addEventListener("select", onSelect);
    }

    // Place or move the plane from the pose
    function placeOrMovePlaneFromPose(pose) {
    // Check if the plane is new
    const wasNewPlane = !placedPlane;

    if (!placedPlane) {
        // Create the plane geometry
        const geometry = new THREE.PlaneGeometry(0.4, 0.4);
        // Create the plane material
        const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: mapTexture || null,
        metalness: 0.1,
        roughness: 0.5,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9
        });

        // Create the plane
        placedPlane = new THREE.Mesh(geometry, material);
        // Cast and receive shadows
        placedPlane.castShadow = true;
        placedPlane.receiveShadow = true;

        // Create the axes helper to see orientation of the plane
        const axesHelper = new THREE.AxesHelper(0.1);
        axesHelper.name = "planeDebugAxes";
        placedPlane.add(axesHelper);

        scene.add(placedPlane);
    }

    // Get the position and orientation of the pose
    const { position, orientation } = pose.transform;
    // Set the position of the plane
    placedPlane.position.set(position.x, position.y, position.z);

    if (planeOrientationOffset) {
        placedPlane.quaternion
        .set(orientation.x, orientation.y, orientation.z, orientation.w)
        .multiply(planeOrientationOffset);
    } else {
        placedPlane.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    }

    if (wasNewPlane) {
        loadEvents().then(() => addEventsToPlane());
        loadRoads().then(() => addRoadsToPlane());
    } else {
        if (eventMarkers.length > 0) addEventsToPlane();
        if (roadMeshes.length > 0) addRoadsToPlane();
    }
    }

    // XR frame loop: hit-test reticle, anchor updates, render
    function onXRFrame(time, frame) {
    const session = frame.session;
    session.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(referenceSpace);
    if (!pose) return;

    if (!hitTestSourceRequested) {
        session.requestReferenceSpace("viewer")
        .then((viewerSpace) => session.requestHitTestSource({ space: viewerSpace }))
        .then((source) => { hitTestSource = source; });
        hitTestSourceRequested = true;
    }

    // Check if the hit test source, reference space, reticle, and placement mode are valid
    if (hitTestSource && referenceSpace && reticle && placementMode) {
        // Get the hit test results
        const hitTestResults = frame.getHitTestResults(hitTestSource);
        if (hitTestResults.length > 0) {
        const hit = hitTestResults[0];
        const hitPose = hit.getPose(referenceSpace);
        if (hitPose) {
            const { position, orientation } = hitPose.transform;
            reticle.visible = true;
            reticle.position.set(position.x, position.y, position.z);

            if (planeOrientationOffset) {
            reticle.quaternion
                .set(orientation.x, orientation.y, orientation.z, orientation.w)
                .multiply(planeOrientationOffset);
            } else {
            reticle.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
            }
        }
        } else {
        reticle.visible = false;
        }
    }

    if (planeAnchor && placedPlane) {
        // Get the anchor pose
        const anchorPose = frame.getPose(
        planeAnchor.anchorSpace || planeAnchor.space || planeAnchor,
        referenceSpace
        );
        if (anchorPose) {
        const t = anchorPose.transform;
        placedPlane.position.set(t.position.x, t.position.y, t.position.z);

        if (planeOrientationOffset) {
            placedPlane.quaternion
            .set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w)
            .multiply(planeOrientationOffset);
        } else {
            placedPlane.quaternion.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
        }

        if (eventMarkers.length > 0) addEventsToPlane();
        if (roadMeshes.length > 0) addRoadsToPlane();
        }
    }

    renderer.render(scene, camera);
    }

    // Five distinct colors for levelcomfort 1–5: red, orange, yellow, blue, green.
    function getComfortColor(level) {
        const i = Math.max(0, Math.min(4, Math.floor(level) - 1));
        const colors = [
            0xef4444, // 1 = red
            0xf97316, // 2 = orange
            0xeab308, // 3 = yellow
            0x3b82f6, // 4 = blue
            0x22c55e  // 5 = green
        ];
        return colors[i];
    }

    // Project WGS84 lat/lon -> plane local X/Z (meters), plane is 0.4m wide and centered at origin
    function projectToMapSurface(lat, lon) {
    const { topLeft, topRight, bottomLeft, bottomRight } = mapCorners;

    const minLat = Math.min(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
    const maxLat = Math.max(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
    const minLon = Math.min(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);
    const maxLon = Math.max(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);

    const normalizedLat = (lat - minLat) / (maxLat - minLat);
    const normalizedLon = (lon - minLon) / (maxLon - minLon);

    const x = (normalizedLon - 0.5) * 0.4;
    const z = (normalizedLat - 0.5) * 0.4;
    return [x, z];
    }

    // Load events CSV once, populate available dates and build markers for active date
    async function loadEvents() {
    if (eventsLoaded) return;

    try {
        const response = await fetch("events_nkpg_WGS84.csv");
        const text = await response.text();
        const lines = text.trim().split("\n");

        const dateSet = new Set();

        for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const parts = line.split(",");
        if (parts.length < 6) continue;

        const id = parts[0];
        const dateTimeEvent = parts[1];
        const lat = parseFloat(parts[2]);
        const lon = parseFloat(parts[3]);
        const levelcomfort = parseInt(parts[5]);

        if (!dateTimeEvent || isNaN(lat) || isNaN(lon) || isNaN(levelcomfort)) continue;

        const datePart = dateTimeEvent.split(" ")[0];
        if (!datePart) continue;

        const [x, z] = projectToMapSurface(lat, lon);

        allEvents.push({ id, dateTimeEvent, date: datePart, lat, lon, levelcomfort, localX: x, localZ: z });
        dateSet.add(datePart);
        }

        eventsLoaded = true;

        const dates = Array.from(dateSet).sort();
        if (!activeEventDate && dates.length > 0) activeEventDate = dates[0];
        populateEventDateFilter(dates);

        rebuildEventMarkersForActiveDate();
    } catch (err) {
        console.error("Failed to load events:", err);
    }
    }

    // Recreate marker meshes for the currently selected date
    function rebuildEventMarkersForActiveDate() {
    while (eventMarkers.length) {
        const m = eventMarkers.pop();
        if (m.userData.shadowCylinder) {
            const c = m.userData.shadowCylinder;
            if (c.geometry) c.geometry.dispose();
            if (c.material) c.material.dispose();
        }
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
    }

    if (!activeEventDate) return;

    for (const ev of allEvents) {
        if (ev.date !== activeEventDate) continue;

        const color = getComfortColor(ev.levelcomfort);
        const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.003, 8, 8),
        new THREE.MeshStandardMaterial({
            color,
            metalness: 0.0,
            roughness: 0.3,
            emissive: color,
            emissiveIntensity: 0.3,
            transparent: true,
            opacity: 0.9
        })
        );

        marker.userData = { ...ev, isEventMarker: true };
        eventMarkers.push(marker);
    }

    if (placedPlane && placedPlane.userData?.eventsGroup) addEventsToPlane();
    }

    // Timestamp -> height (0.01m - 0.2m) for markers in the current date
    function calculateHeightFromTimestamp(eventMarkers, targetMarker) {
    // Check if there are less than 2 event markers
    if (eventMarkers.length <= 1) return 0.01;

    let minTime = Infinity;
    let maxTime = -Infinity;

    for (const marker of eventMarkers) {
        const dt = marker.userData.dateTimeEvent;
        if (!dt) continue;
        const d = new Date(dt.replace(/\//g, "-"));
        if (isNaN(d.getTime())) continue;
        const t = d.getTime();
        if (t < minTime) minTime = t;
        if (t > maxTime) maxTime = t;
    }
    // Check if the min and max time are the same
    if (minTime === maxTime) return 0.01;

    const targetDT = targetMarker.userData.dateTimeEvent;
    // Check if the target date time is valid
    if (!targetDT) return 0.01;

    const td = new Date(targetDT.replace(/\//g, "-"));
    if (isNaN(td.getTime())) return 0.01;

    const normalized = (td.getTime() - minTime) / (maxTime - minTime);
    return 0.01 + (normalized * (0.2 - 0.01));
    }

    // Add markers as children of the plane (localX/localZ are in plane space)
    function addEventsToPlane() {
    if (!placedPlane || eventMarkers.length === 0) return;

    if (!placedPlane.userData.eventsGroup) {
        const eventsGroup = new THREE.Group();
        eventsGroup.name = "eventsGroup";
        eventsGroup.rotation.y = 0;
        placedPlane.add(eventsGroup);
        placedPlane.userData.eventsGroup = eventsGroup;
    }

    const eventsGroup = placedPlane.userData.eventsGroup;
    if (!eventsGroup) return;

    while (eventsGroup.children.length) eventsGroup.remove(eventsGroup.children[0]);

    const shadowRadius = 0.0015; 
    const shadowSegments = 8; // shadowCylinder is 8 for low polygon count.

    for (const marker of eventMarkers) {
        const height = calculateHeightFromTimestamp(eventMarkers, marker);
        marker.position.set(marker.userData.localX, marker.userData.localZ, height);
        marker.quaternion.identity();

        if (!marker.userData.shadowCylinder) {
            const color = marker.material.color.getHex();
            const cylGeom = new THREE.CylinderGeometry(shadowRadius, shadowRadius, height, shadowSegments);
            const cylMat = new THREE.MeshStandardMaterial({
                color,
                metalness: 0,
                roughness: 0.4,
                emissive: color,
                emissiveIntensity: 0.2
            });
            const cylinder = new THREE.Mesh(cylGeom, cylMat);
            cylinder.rotation.x = -Math.PI / 2;
            cylinder.position.z = -height / 2;
            marker.add(cylinder);
            marker.userData.shadowCylinder = cylinder;
        } else {
            const cylinder = marker.userData.shadowCylinder;
            cylinder.position.z = -height / 2;
        }

        eventsGroup.add(marker);
    }
    }

    function removeEventsFromPlane() {
    const eventsGroup = placedPlane?.userData?.eventsGroup;
    if (eventsGroup) placedPlane.userData.eventsGroup = null;
    }

    // Build a flat ribbon strip along points (for thick road lines)
    function createRibbonGeometry(points, width) {
    if (!points || points.length < 2) return null;

    const halfWidth = width / 2;
    const positions = [];
    const indices = [];

    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];

        const dir = new THREE.Vector3().subVectors(p2, p1).normalize();
        const perp = new THREE.Vector3(-dir.y, dir.x, 0).multiplyScalar(halfWidth);

        const v1 = new THREE.Vector3().addVectors(p1, perp);
        const v2 = new THREE.Vector3().subVectors(p1, perp);
        const v3 = new THREE.Vector3().addVectors(p2, perp);
        const v4 = new THREE.Vector3().subVectors(p2, perp);

        const baseIndex = positions.length / 3;

        positions.push(
        v1.x, v1.y, v1.z,
        v2.x, v2.y, v2.z,
        v3.x, v3.y, v3.z,
        v4.x, v4.y, v4.z
        );

        indices.push(
        baseIndex, baseIndex + 1, baseIndex + 2,
        baseIndex + 1, baseIndex + 3, baseIndex + 2
        );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
    }

    // Load roads GeoJSON once and build ribbon meshes in plane local space
    async function loadRoads() {
    if (roadsLoaded) return;

    try {
        const response = await fetch("roads_nkpg_WGS84.geojson");
        const geojson = await response.json();

        if (!geojson.features || !Array.isArray(geojson.features)) {
        console.error("Invalid GeoJSON structure");
        return;
        }

        let roadCount = 0;

        for (const feature of geojson.features) {
        if (!feature.geometry || feature.geometry.type !== "MultiLineString") continue;

        const coordinates = feature.geometry.coordinates;
        if (!coordinates || !Array.isArray(coordinates)) continue;

        for (const lineString of coordinates) {
            if (!Array.isArray(lineString) || lineString.length < 2) continue;

            const projectedPoints = [];

            for (const coord of lineString) {
            const lon = coord[0];
            const lat = coord[1];
            if (isNaN(lon) || isNaN(lat)) continue;

            const [x, z] = projectToMapSurface(lat, lon);
            projectedPoints.push(new THREE.Vector3(x, z, 0));
            }

            if (projectedPoints.length < 2) continue;

            const geometry = createRibbonGeometry(projectedPoints, 0.002);
            if (!geometry) continue;

            const roadMaterial = new THREE.MeshBasicMaterial({
            color: 0x000000,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1
            });

            const roadMesh = new THREE.Mesh(geometry, roadMaterial);
            roadMesh.userData = { isRoad: true, localPoints: projectedPoints };
            roadMeshes.push(roadMesh);
            roadCount++;
        }
        }

        roadsLoaded = true;
        console.log(`Loaded ${roadCount} road segments`);
    } catch (err) {
        console.error("Failed to load roads:", err);
    }
    }

    // Add road meshes as children of the plane
    function addRoadsToPlane() {
    if (!placedPlane || roadMeshes.length === 0) return;

    if (!placedPlane.userData.roadsGroup) {
        const roadsGroup = new THREE.Group();
        roadsGroup.name = "roadsGroup";
        roadsGroup.rotation.y = 0;
        placedPlane.add(roadsGroup);

        for (const road of roadMeshes) {
        road.position.set(0, 0, 0);
        roadsGroup.add(road);
        }

        placedPlane.userData.roadsGroup = roadsGroup;
    }
    }

    function removeRoadsFromPlane() {
    for (const roadMesh of roadMeshes) scene.remove(roadMesh);
    }

    // Placement mode toggle
    placementToggleButton.addEventListener("click", () => {
    blockNextSelect = true;
    placementMode = !placementMode;

    placementToggleButton.textContent = placementMode ? "Placement: ON" : "Placement: OFF";
    instructionsEl.textContent = placementMode
        ? "Placement mode: ON – move to find a surface, then tap to place a plane."
        : "Placement mode: OFF – walk around and observe the plane or explore dates.";

    if (!placementMode && reticle) reticle.visible = false;
    });

    enterARButton.addEventListener("click", () => {
    startAR().catch((err) => {
        console.error(err);
        alert("Failed to start AR: " + err.message);
    });
    });

    function updateEventDateLabel() {
    const labelEl = document.getElementById("event-date-label");
    if (!labelEl) return;
    labelEl.textContent = activeEventDate || "No date";
    }

    function populateEventDateFilter(dates) {
    availableEventDates = dates || [];
    if (!activeEventDate && availableEventDates.length > 0) activeEventDate = availableEventDates[0];
    updateEventDateLabel();
    }

    const eventDatePrev = document.getElementById("event-date-prev");
    const eventDateNext = document.getElementById("event-date-next");
    const eventDateLabel = document.getElementById("event-date-label");

    const dateUiElements = [eventDatePrev, eventDateNext, eventDateLabel].filter(Boolean);
    dateUiElements.forEach((el) => {
    ["pointerdown", "mousedown", "touchstart", "click"].forEach((evt) => {
        el.addEventListener(evt, () => { blockNextSelect = true; });
    });
    });

    // Prev/next date selection (rebuild markers)
    function changeActiveDate(direction) {
    if (!availableEventDates.length) return;

    let idx = availableEventDates.indexOf(activeEventDate);
    if (idx === -1) idx = 0;

    idx = (idx + direction + availableEventDates.length) % availableEventDates.length;
    activeEventDate = availableEventDates[idx];

    updateEventDateLabel();
    rebuildEventMarkersForActiveDate();
    }

    if (eventDatePrev) {
    eventDatePrev.addEventListener("click", () => {
        blockNextSelect = true;
        changeActiveDate(-1);
    });
    }

    if (eventDateNext) {
    eventDateNext.addEventListener("click", () => {
        blockNextSelect = true;
        changeActiveDate(1);
    });
    }
})();
