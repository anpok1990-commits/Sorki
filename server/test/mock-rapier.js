// Поддельный Rapier для тестов сервера без npm (протокол, база, комнаты).
// Физику НЕ проверяет: фишки случайно «переворачиваются». Настоящую физику проверяет test-determinism.js.
class Desc {
  constructor() { this.t = { x: 0, y: 0, z: 0 }; this.r = { x: 0, y: 0, z: 0, w: 1 }; }
  setTranslation(x, y, z) { this.t = { x, y, z }; return this; }
  setRotation(q) { this.r = { ...q }; return this; }
}
for (const k of ['setLinvel', 'setAngvel', 'setCcdEnabled', 'setAngularDamping', 'setLinearDamping', 'setCanSleep', 'setAdditionalMass'])
  Desc.prototype[k] = function () { return this; };
function cd() { const o = {}; for (const k of ['setDensity', 'setFriction', 'setRestitution', 'setMass']) o[k] = () => o; return o; }
export const MockRapier = {
  RigidBodyDesc: { dynamic: () => new Desc(), fixed: () => new Desc() },
  ColliderDesc: { cuboid: cd, roundCylinder: cd, cylinder: cd, ball: cd },
  World: class {
    constructor() { this.b = []; this.integrationParameters = { numSolverIterations: 4 }; }
    createRigidBody(d) {
      const b = { t: { ...d.t }, r: { ...d.r }, translation() { return this.t; }, rotation() { return this.r; },
        linvel() { return { x: 0, y: 0, z: 0 }; }, angvel() { return { x: 0, y: 0, z: 0 }; }, isSleeping() { return true; } };
      this.b.push(b); return b;
    }
    createCollider() {}
    step() { for (const b of this.b) if (Math.random() < 0.01) b.r = { x: 0, y: 0, z: 0, w: 1 }; }
    free() {}
  },
};
