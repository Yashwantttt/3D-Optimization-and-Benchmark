# 3D-Optimization-and-Benchmark

A browser-based 3D forest environment built with **Three.js** for studying and comparing WebGL rendering performance and optimization techniques.

The project allows different numbers of trees, grass, and rocks to be rendered while monitoring real-time performance metrics such as FPS, frame time, draw calls, triangles, geometries, and textures.

The long-term goal is to use this environment as a controlled benchmark for evaluating different techniques for optimizing large 3D scenes on low-end hardware and creating an Adaptive Rendering Framework that will adjust different optimization parameters based on device performance and load.


---

## Live Demo

**Live Demo:**  
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/

> The live demo is hosted using GitHub Pages.

---

##  Project Goals

The main goal of this project is to investigate how different Three.js/WebGL optimization techniques affect the performance of large 3D environments.

The project is designed to answer questions such as:

- How does increasing the number of 3D objects affect FPS?
- How much can `THREE.InstancedMesh` reduce rendering overhead?
- How does Level of Detail (LOD) affect performance?
- How effective is distance-based culling?
- How does frustum culling affect large scenes?
- How does texture resolution affect performance?
- How do different optimization techniques interact with each other?
- How well can a large 3D scene run on low-end hardware?

---

##  Project Contributors
- **Vidhushi Singh**
- **Vishaka Dhanotiya**
- **Yashwant**


##  Technologies Used

- **HTML5**
- **CSS3**
- **JavaScript**
- **Three.js**
- **WebGL**
- **GLTF / GLB 3D models**
- **Git & GitHub**
- **GitHub Pages**

---

##  Current Features

### 3D Environment

- Procedurally generated forest
- Tree models
- Grass models
- Rock models
- Large ground environment
- Lighting and shadows
- Fog
- Interactive camera
- OrbitControls

### Performance Monitoring

The application monitors several Three.js rendering statistics:

- Current FPS
- Average FPS
- Minimum FPS
- Frame time
- Draw calls
- Triangle count
- Geometry count
- Texture count

Three.js renderer statistics are obtained using `renderer.info` where applicable.

---

##  Scene Controls

The scene can be configured using sliders for different object types.

| Object | Purpose |
|---|---|
| 🌲 Trees | Control number of tree instances |
| 🌿 Grass | Control number of grass instances |
| 🪨 Rocks | Control number of rock instances |

This makes it possible to test how scene complexity affects rendering performance.

Example:

```text
Trees  →  1,000
Grass  → 10,000
Rocks  →    500