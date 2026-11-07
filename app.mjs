import {importAccessKey,rememberedKey,rememberKey,forgetPageKeys} from './device-auth.mjs';
import {createPartsController} from './parts-controller.mjs';
// Shared by the generated STEP module, web controls and GLB animation compiler.
// Absolute world transforms: rotate about the CAD datum, then translate.
function createSequencePlayer(data) {
  const fail = message => { throw Error('sequence: ' + message); };
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const vec = (v, label) => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) fail(label + ' requires 3 finite numbers');
    return [...v];
  };
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-8);
  if (data?.schemaVersion !== 1 || data.coordinateSystem !== 'CAD_WORLD_MM_Z_UP') fail('unsupported schema/coordinates');
  if (!/^[a-f0-9]{64}$/.test(data.sourceSha256)) fail('missing source identity');
  if (!Array.isArray(data.parts) || !data.parts.length || !Array.isArray(data.stages)) fail('parts/stages missing');
  const parts = new Map(), fixed = new Set(data.fixedPartIds || []);
  const targets = [...data.parts, ...(data.subTargets || [])];
  for (const part of targets) {
    if (typeof part.id !== 'string' || parts.has(part.id)) fail('duplicate/invalid part id');
    if (typeof part.localTarget !== 'string' || !/^#?o\d+(\.\d+)*$/.test(part.localTarget)) fail(part.id + ': occurrence target missing');
    parts.set(part.id, part);
  }
  for (const id of fixed) if (!parts.has(id)) fail('unknown fixed part ' + id);
  for (const target of data.subTargets || []) if (!data.parts.some(p => p.id === target.parentPartId)) fail('unknown subtarget parent ' + target.id);
  const stages = [], ids = new Map(), previous = new Map();
  for (const p of parts.values()) previous.set(p.id, { translationMm: [0, 0, 0], angleDeg: 0, axis: [0, 0, 1], originMm: [0, 0, 0] });
  let total = 0;
  for (const stage of data.stages) {
    if (typeof stage.id !== 'string' || ids.has(stage.id)) fail('duplicate/invalid stage id');
    if (!finite(stage.duration) || stage.duration <= 0) fail(stage.id + ': invalid duration');
    if (!['release', 'extract', 'park', 'hold'].includes(stage.kind)) fail(stage.id + ': unknown kind');
    if (!Array.isArray(stage.dependsOn) || !Array.isArray(stage.motions)) fail(stage.id + ': dependencies/motions missing');
    for (const id of stage.dependsOn) if (!ids.has(id)) fail(stage.id + ': missing/later dependency ' + id);
    const used = new Set();
    const motions = stage.motions.map(motion => {
      if (!Array.isArray(motion.partIds) || !motion.partIds.length) fail(stage.id + ': empty motion');
      const from = vec(motion.translationMm?.from, stage.id + '.from'), to = vec(motion.translationMm?.to, stage.id + '.to');
      let rotation = null;
      if (motion.rotation) {
        const r = motion.rotation, axis = vec(r.axis, stage.id + '.axis'), originMm = vec(r.originMm, stage.id + '.origin');
        const length = Math.hypot(...axis);
        if (length < 1e-12 || !finite(r.fromDeg) || !finite(r.toDeg)) fail(stage.id + ': invalid rotation');
        rotation = { axis: axis.map(v => v / length), originMm, fromDeg: r.fromDeg, toDeg: r.toDeg };
      }
      for (const id of motion.partIds) {
        if (!parts.has(id) || used.has(id) || fixed.has(id)) fail(stage.id + ': invalid/duplicate/fixed target ' + id);
        used.add(id);
        const p = previous.get(id);
        if (!same(p.translationMm, from)) fail(stage.id + ': discontinuous translation for ' + id);
        if (rotation) {
          if (Math.abs(p.angleDeg - rotation.fromDeg) > 1e-8) fail(stage.id + ': discontinuous angle for ' + id);
          if (p.angleDeg !== 0 && (!same(p.axis, rotation.axis) || !same(p.originMm, rotation.originMm))) fail(stage.id + ': changed rotation datum for ' + id);
        }
        previous.set(id, { translationMm: to, angleDeg: rotation?.toDeg ?? p.angleDeg, axis: rotation?.axis ?? p.axis, originMm: rotation?.originMm ?? p.originMm });
      }
      return { partIds: [...motion.partIds], from, to, rotation };
    });
    for (const id of used) if (parts.get(id)?.parentPartId && used.has(parts.get(id).parentPartId)) fail(stage.id + ': parent/child driven together ' + id);
    const parsed = { ...stage, start: total, end: total + stage.duration, motions };
    stages.push(parsed); ids.set(stage.id, parsed); total = parsed.end;
  }
  const blockingIssues = (data.unresolved || []).filter(issue => issue.blocking === true);
  const blockedStage = stages.find(stage => stage.blocked === true || stage.validation === 'blocked' || stage.motions.some(m => m.partIds.some(id => blockingIssues.some(issue => issue.partIds?.includes(id) || issue.partIds?.includes(parts.get(id)?.parentPartId) || issue.targetIds?.includes(id)))));
  const playableDuration = blockedStage ? blockedStage.start : total;
  const identity = () => ({ translationMm: [0, 0, 0], angleDeg: 0, axis: [0, 0, 1], originMm: [0, 0, 0] });
  function at(seconds) {
    if (!finite(seconds)) fail('time must be finite');
    const time = Math.min(playableDuration, Math.max(0, seconds)), states = {};
    for (const id of parts.keys()) states[id] = identity();
    for (const stage of stages) {
      if (time <= stage.start) break;
      const f = Math.min(1, (time - stage.start) / stage.duration);
      for (const m of stage.motions) for (const id of m.partIds) {
        const state = states[id];
        state.translationMm = m.from.map((v, i) => v + (m.to[i] - v) * f);
        if (m.rotation) {
          state.angleDeg = m.rotation.fromDeg + (m.rotation.toDeg - m.rotation.fromDeg) * f;
          state.axis = [...m.rotation.axis]; state.originMm = [...m.rotation.originMm];
        }
      }
    }
    const stageIndex = stages.length ? Math.min(stages.length - 1, stages.findIndex(s => time < s.end) < 0 ? stages.length - 1 : stages.findIndex(s => time < s.end)) : -1;
    return { time, total: playableDuration, stageIndex, stage: stages[stageIndex] || null, states, blocked: Boolean(blockedStage && time >= playableDuration) };
  }
  return { data, parts: data.parts, targets: [...parts.values()], stages, duration: playableDuration, candidateDuration: total, blockedStage: blockedStage || null, at };
}

function stateMatrix(state, glb = false) {
  const convert = v => glb ? [v[0], v[2], -v[1]] : [...v];
  const [x, y, z] = convert(state.axis), angle = state.angleDeg * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle), q = 1 - c;
  const r = [x*x*q+c, y*x*q+z*s, z*x*q-y*s, 0, x*y*q-z*s, y*y*q+c, z*y*q+x*s, 0, x*z*q+y*s, y*z*q-x*s, z*z*q+c, 0, 0, 0, 0, 1];
  const o = convert(state.originMm), t = convert(state.translationMm), scale = glb ? .001 : 1;
  for (let i=0;i<3;i++) r[12+i] = scale*(t[i]+o[i]-r[i]*o[0]-r[4+i]*o[1]-r[8+i]*o[2]);
  return r;
}

function applyCadFrame(player, time, model) {
  const frame = player.at(time);
  for (const part of player.targets) {
    const s = frame.states[part.id], handle = model.get(part.localTarget.startsWith('#') ? part.localTarget : '#'+part.localTarget);
    // Resolve every target at t=0 as well; the Viewer validates targets at load.
    if (s.angleDeg) handle.rotate(s.axis, s.angleDeg, s.originMm);
    if (s.translationMm.some(v => v !== 0)) handle.translate(s.translationMm);
  }
  return frame;
}

const opCoordinates = (() => {

const cadVectorToGlb = ([x, y, z]) => [x, z, -y];
const glbVectorToCad = ([x, y, z]) => [x, -z, y];
const cadPointToGlb = point => cadVectorToGlb(point).map(value => value * 0.001);

function cadVector(matrix, vector) {
  return matrix.slice(0, 3).map(row => vector.reduce((sum, value, i) => sum + row[i] * value, 0));
}

function cadPoint(matrix, point) {
  return cadVector(matrix, point).map((value, i) => value + matrix[i][3]);
}

function inverseCadVector(matrix, vector) {
  return [0, 1, 2].map(column => vector.reduce((sum, value, row) => sum + matrix[row][column] * value, 0));
}

function inverseCadPoint(matrix, point) {
  return inverseCadVector(matrix, point.map((value, i) => value - matrix[i][3]));
}

function glbMatrix(matrix) {
  return [
    ...[0, 1, 2].flatMap(column => {
      const glbBasis = [0, 0, 0];
      glbBasis[column] = 1;
      return [...cadVectorToGlb(cadVector(matrix, glbVectorToCad(glbBasis))), 0];
    }),
    ...cadPointToGlb(cadPoint(matrix, [0, 0, 0])), 1,
  ];
}

function transformBounds(matrix, bounds) {
  const points = Array.from({ length: 8 }, (_, index) =>
    cadPoint(matrix, [0, 1, 2].map(axis => bounds[(index >> axis) & 1][axis])));
  return [Math.min, Math.max].map(extreme => [0, 1, 2].map(axis => extreme(...points.map(p => p[axis]))));
}

return { cadPoint, cadVector, cadVectorToGlb, cadPointToGlb };
})();

const opSpringGeometry = (() => {
const { cadPoint } = opCoordinates;
const add = (a, b) => a.map((v, i) => v + b[i]);
const scale = (v, k) => v.map(x => x * k);
const mix = (a, b, s) => a.map((v, i) => v + (b[i] - v) * s);
const unit = v => scale(v, 1 / Math.hypot(...v));
const range = (count, fn) => Array.from({ length: count }, (_, i) => fn(i / count));

function springCenterline(row, oldToNew) {
  const { R, N, angle, alpha_deg, coil_xy_old_mm } = row.spring;
  const half = alpha_deg * Math.PI / 360, sin = Math.sin(half), cos = Math.cos(half);
  const pitch = 0.42, bend = 0.5, lead = pitch / (2 * Math.PI * R);
  const uA = unit([-sin, cos, -lead]), uB = unit([sin, cos, lead]);
  const rise = pitch * N, startZ = 29.90 - rise - 3.25 * lead + bend * Math.tan(Math.acos(-uB[2]) / 2);
  const legA = [-R * cos - 4.5 * sin, 4.5 * cos - R * sin, startZ - 4.5 * lead];
  const legB = [R * cos + 3.25 * sin, 3.25 * cos - R * sin, startZ + rise + 3.25 * lead];
  const helix = s => {
    const azimuth = Math.PI + half + 2 * Math.PI * N * s;
    return [R * Math.cos(azimuth), R * Math.sin(azimuth), startZ + rise * s];
  };
  function elbow(foot, direction, endZ) {
    const arc = Math.acos(-direction[2]);
    const distance = bend * Math.tan(arc / 2);
    const start = add(foot, scale(direction, -distance));
    const normal = unit(add([0, 0, -1], scale(direction, direction[2])));
    const center = add(start, scale(normal, bend));
    const along = s => add(center, add(scale(normal, -bend * Math.cos(arc * s)), scale(direction, bend * Math.sin(arc * s))));
    return { start, along, end: [foot[0], foot[1], endZ] };
  }
  const a = elbow(legA, uA, 25.25), b = elbow(legB, uB, 28.10);
  const c = Math.cos(angle - Math.PI / 2), s = Math.sin(angle - Math.PI / 2);
  return [
    ...range(4, t => mix(a.end, a.along(1), t)),
    ...range(12, t => a.along(1 - t)),
    ...range(8, t => mix(a.start, helix(0), t)),
    ...range(256, helix),
    ...range(8, t => mix(helix(1), b.start, t)),
    ...range(12, b.along),
    ...range(4, t => mix(b.along(1), b.end, t)),
    b.end,
  ].map(([x, y, z]) => cadPoint(oldToNew, [
    coil_xy_old_mm[0] + x * c - y * s, coil_xy_old_mm[1] + x * s + y * c, z,
  ]));
}

function reduceSpringPoses(timedCenterlines, toleranceMm = 0.025) {
  const selected = new Set([0, timedCenterlines.length - 1]);
  function split(first, last) {
    const from = timedCenterlines[first], to = timedCenterlines[last];
    let worst = toleranceMm, splitAt = -1;
    for (let i = first + 1; i < last; i++) {
      const { time, points } = timedCenterlines[i], fraction = (time - from.time) / (to.time - from.time);
      for (const [j, point] of points.entries()) {
        const error = Math.hypot(...point.map((v, k) => v - (from.points[j][k] + (to.points[j][k] - from.points[j][k]) * fraction)));
        if (error > worst) {
          splitAt = i;
          worst = error;
        }
      }
    }
    if (splitAt < 0) return;
    selected.add(splitAt);
    split(first, splitAt);
    split(splitAt, last);
  }
  split(0, timedCenterlines.length - 1);
  return [...selected].sort((a, b) => a - b).map(i => timedCenterlines[i]);
}

return { springCenterline };
})();

const opTorsion284 = (() => {

// Axial layout of the lower, two-turn torsion spring.
const spring285Axial = Object.freeze({
  padTopOldZ: 26.55,
  wireRadiusMm: .175,
  pitchMm: .42,
  bendRadiusMm: .40,
  pitchLeadTurns: .10,
  fixedFootTipOldZ: 24.25,
  movingFootTipOldZ: 29.50,
});

const TAU = 2 * Math.PI;
const sample = (count, point) => Array.from({ length: count + 1 }, (_, i) => point(i / count));
const offset = (point, unit, distance, z) => [point[0] + unit[0] * distance, point[1] + unit[1] * distance, z];

function pitchRun(turn, total, ramp) {
  const lead = distance => {
    const u = distance / ramp;
    return ramp * (u ** 3 - u ** 4 / 2);
  };
  if (turn < ramp) return lead(turn);
  if (turn > total - ramp) return total - ramp - lead(total - turn);
  return turn - ramp / 2;
}

function springSegments285(row, oldToWorld) {
  const { R, N, alpha_deg: alphaDeg, angle, coil_xy_old_mm: coil } = row.spring;
  const { padTopOldZ, wireRadiusMm, pitchMm, bendRadiusMm: bend, pitchLeadTurns,
    fixedFootTipOldZ, movingFootTipOldZ } = spring285Axial;
  const half = alphaDeg * Math.PI / 360;
  const sine = Math.sin(half), cosine = Math.cos(half);
  const start = [-R * cosine, -R * sine], end = [R * cosine, -R * sine];
  const outwardA = [-sine, cosine], outwardB = [sine, cosine];
  const armA = 4.5, armB = 3.25;
  const floor = padTopOldZ + wireRadiusMm;
  const crown = floor + pitchMm * pitchRun(N, N, pitchLeadTurns);
  const aTip = offset(start, outwardA, armA, fixedFootTipOldZ);
  const bTip = offset(end, outwardB, armB, movingFootTipOldZ);
  const aBend = sample(12, t => {
    const phase = t * Math.PI / 2;
    return offset(start, outwardA, armA - bend + bend * Math.cos(phase),
      floor - bend + bend * Math.sin(phase));
  });
  const bBend = sample(12, t => {
    const phase = t * Math.PI / 2;
    return offset(end, outwardB, armB - bend + bend * Math.sin(phase),
      crown + bend * (1 - Math.cos(phase)));
  });
  const winding = sample(192, t => {
    const turn = N * t, phase = Math.PI + half + TAU * turn;
    return [R * Math.cos(phase), R * Math.sin(phase), floor + pitchMm * pitchRun(turn, N, pitchLeadTurns)];
  });
  const local = [
    { kind: 'line', points: [aTip, aBend[0]] },
    { kind: 'arc', points: aBend },
    { kind: 'line', points: [aBend.at(-1), winding[0]] },
    { kind: 'spline', points: winding, tangents: [[sine, -cosine, 0], [sine, cosine, 0]] },
    { kind: 'line', points: [winding.at(-1), bBend[0]] },
    { kind: 'arc', points: bBend },
    { kind: 'line', points: [bBend.at(-1), bTip] },
  ];
  const c = Math.cos(angle - Math.PI / 2), s = Math.sin(angle - Math.PI / 2);
  const rotate = ([x, y, z]) => [x * c - y * s, x * s + y * c, z];
  const transform = (vector, point) => oldToWorld.slice(0, 3).map(row =>
    row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2] + (point ? row[3] : 0));
  return local.map(({ kind, points, tangents }) => ({
    kind,
    points: points.map(point => {
      const [x, y, z] = rotate(point);
      return transform([coil[0] + x, coil[1] + y, z], true);
    }),
    tangents: tangents?.map(tangent => transform(rotate(tangent), false)),
  }));
}

function springCenterline285(row, oldToWorld) {
  return springSegments285(row, oldToWorld).flatMap(({ points }, index) => index ? points.slice(1) : points);
}

return { springCenterline285, spring285Axial };
})();

const opState = (() => {
const { cadPoint, cadVector } = opCoordinates; const { springCenterline } = opSpringGeometry;
const RAD = Math.PI / 180;
const ids = (...numbers) => numbers.map(n => 'part-' + String(n).padStart(2, '0'));
const standardRoles = {
  main: ids(4, 5, 6, 7, 19, 20, 21, 22, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 53),
  spool: ids(8, 16), pinion: ids(9, 12), worm: ids(42, 52), yoke: ids(11),
  input: ids(14, 15, 51), sleeve: ids(41, 62), guide: ids(43, 44, 58, 59, 60, 61),
  follower: ids(44), pawl: ids(54, 55), spring: 'part-56',
};
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const positive = n => Number.isFinite(n) ? Math.max(0, n) : 0;
const spinPhase = n => (n % 360 + 360) % 360;

function createOperationState(data, contact, coupling, torsion) {
  const roles = { ...standardRoles, ...data.roles };
  const contactOrigin = contact.initial(0);
  const datum = data.datum;
  const zAxis = cadVector(datum, [0, 0, 1]);
  const cam = cadPoint(datum, data.camAxisOld || [0, 0, 0]);
  const main = cadPoint(datum, data.mainAxisOld || [-12, 18.439088914585852, 0]);
  const worm = cadPoint(datum, [0, 28, 11.58]);
  const followerPhase = (data.gearing.followerPhaseDeg ?? 102.56388566155659) * RAD;
  const followerAxis = cadVector(datum, [Math.cos(followerPhase), Math.sin(followerPhase), 0]);
  const pivot = cadPoint(datum, [...contactOrigin.ear_pin_xy_old_mm, 0]);
  const ratio = data.gearing.driver / data.gearing.driven;
  const mainDriveRatio = 184 / 25;
  const springVersion = data.torsionSpring;
  const centerline = springVersion ? torsion?.['springCenterline' + springVersion] : springCenterline;
  const wireRadiusMm = torsion?.['spring' + springVersion + 'Axial']?.wireRadiusMm;
  if (springVersion && (typeof centerline !== 'function' || !(wireRadiusMm > 0))) throw Error('缺少下置扭簧中心线');
  const baselineSpring = centerline(contactOrigin, datum);
  const baselineFlexKey = contactOrigin.q + ':' + contactOrigin.phi;
  const compressionSprings = data.compressionSprings || [];
  const pressQ = data.pressQ ?? -27;
  const plateStopTolerance = 1e-6;
  const plateRate = 60;
  const passivePlate = data.passivePlate === true;
  const controlsVersion = data.controlsVersion;
  if (passivePlate && (!contact.advanceFreePlate || !contact.releaseHigh)) throw Error('缺少按板接触或松手求解器');
  let state;
  let lastFlex = null, poseState = null, cachedPose = null;
  let compressionLift, compressed = [];

  function reset() {
    state = { clutch: contactOrigin, drive: coupling.initialCoupling(0, 0), action: 'reset' };
    return state;
  }

  function clutchIsReset() {
    const { clutch, drive } = state;
    return clutch.event === 'low-stop' && drive.engaged && drive.dogContact === 'seated' &&
      Math.abs(drive.pinionLift) < 1e-6 && Math.abs(drive.yokeLift) < 1e-6;
  }

  function canReverseSpool() {
    const { drive } = state;
    const clearLift = coupling.CLEAR_LIFT_MM ?? data.contact.coupling?.axialClearLiftMm;
    return !drive.engaged && !drive.inserting && !drive.waiting && !drive.leadInSpring &&
      drive.dogContact === 'free' && drive.pinionLift >= clearLift - 1e-6;
  }

  function windSpool(degrees, dtSeconds) {
    if (!positive(degrees)) return state;
    const { clutch, drive } = state;
    if (!drive.engaged) return advance('spool', -degrees, dtSeconds);
    const elapsed = dtSeconds === undefined ? degrees / 150 : positive(dtSeconds);
    // At LOW the remaining axial seat travel adds helix rotation opposite the winding input.
    const seating = clutch.event === 'low-stop' ? Math.min(drive.pinionLift, elapsed * 20) : 0;
    const correction = seating ? -coupling.HELIX_DEG_PER_MM * seating : 0;
    return advance('crank', (degrees + correction) / mainDriveRatio, elapsed);
  }

  function validatePlateTrace(before, after) {
    let gamma = before.gamma;
    for (const step of after.steps) {
      if (!Number.isFinite(step.gamma) || step.gamma < gamma - 1e-9) throw Error('Invalid plate contact trace');
      gamma = step.gamma;
    }
    if (after.motionInput !== 'plate' || !Number.isFinite(after.gamma) || !Number.isFinite(after.passiveMainDeltaDeg) ||
        Math.abs(gamma - after.gamma) > 1e-7 ||
        Math.abs(after.passiveMainDeltaDeg - (after.gamma - before.gamma)) > 1e-7) {
      throw Error('Plate contact trace does not account for crank movement');
    }
  }

  function advancePassivePlate(target) {
    let { clutch, drive } = state;
    const startGamma = clutch.gamma, direction = Math.sign(target - clutch.q);
    const steps = [], leadInSteps = [];
    let passiveSpoolDeltaDeg = 0;
    while (direction * (target - clutch.q) > 1e-8) {
      // Complete absolute tenths of a degree before publishing a new mechanical state.
      const scaled = clutch.q * 10;
      const tick = direction < 0 ? Math.ceil(scaled - 1e-7) - 1 : Math.floor(scaled + 1e-7) + 1;
      const q = tick / 10;
      if (direction * (q - target) > 1e-8) break;
      const next = contact.advanceFreePlate(clutch, q);
      validatePlateTrace(clutch, next);
      const travel = 20 * Math.abs(next.q - clutch.q) / plateRate;
      drive = coupling.advanceCoupling(drive, clutch, next, 0, travel);
      passiveSpoolDeltaDeg += drive.passiveSpoolDeltaDeg || 0;
      leadInSteps.push(...(drive.leadInSteps || []));
      steps.push(...next.steps);
      const progressed = Math.abs(next.q - clutch.q) > 1e-8;
      clutch = next;
      if (next.blocked || !progressed) break;
    }
    if (clutch !== state.clutch) {
      state = {
        clutch: { ...clutch, steps, passiveMainDeltaDeg: clutch.gamma - startGamma },
        drive: { ...drive, passiveSpoolDeltaDeg, leadInSteps }, action: 'plate',
      };
    }
    return state;
  }

  function advance(kind, value, dtSeconds) {
    const { clutch: before, drive: previousDrive } = state;
    if (kind === 'crank' && !positive(value)) return state;
    if (kind === 'spool' && (!Number.isFinite(value) || !value || state.drive.engaged)) return state;
    const seatStepMm = dtSeconds === undefined ? undefined : positive(dtSeconds) * 20;
    let after = before, spoolDelta = 0, drive;
    if (kind === 'plate') {
      const target = clamp(value, pressQ, 0);
      if (passivePlate) return advancePassivePlate(target);
      after = contact.advancePlate(before, target);
    }
    if (kind === 'release') {
      if (!passivePlate || Math.abs(before.q - pressQ) > plateStopTolerance) return state;
      after = contact.releaseHigh(before.q === pressQ ? before : { ...before, q: pressQ });
      validatePlateTrace(before, after);
    }
    if (kind === 'crank' && positive(value)) {
      const target = before.gamma + positive(value);
      if (coupling.advanceCoupledCrank) {
        ({ clutch: after, drive } = coupling.advanceCoupledCrank(contact, before, previousDrive, target, seatStepMm));
      } else {
        after = contact.advanceCrank(before, target);
      }
    }
    if (kind === 'spool' && Number.isFinite(value) && !state.drive.engaged) spoolDelta = value;
    if (!['plate', 'release', 'crank', 'spool', 'settle'].includes(kind)) throw Error('Unknown mechanical action');
    const gammaDelta = after.gamma - before.gamma;
    if (!Number.isFinite(gammaDelta) || gammaDelta < -1e-9 ||
        (kind !== 'release' && gammaDelta > (kind === 'crank' ? positive(value) : 0) + 1e-7)) {
      throw Error('Unexpected change of crank phase');
    }
    if (after === before && !drive && !spoolDelta && kind !== 'settle') {
      state = { ...state, action: kind };
      return state;
    }
    const couplingFrom = after === before ? { ...before, steps: [] } : after;
    drive ||= coupling.advanceCoupling(previousDrive, before, couplingFrom, spoolDelta, seatStepMm);
    state = { clutch: after, drive, action: kind };
    return state;
  }

  const { radius, phase } = data.flip;
  const slotDirection = q => {
    const angle = (phase + q) * RAD;
    return Math.atan2(radius * Math.sin(angle) - 28, radius * Math.cos(angle));
  };
  const restSlot = slotDirection(0);
  const guideTurn = q => Math.atan2(Math.sin(slotDirection(q) - restSlot), Math.cos(slotDirection(q) - restSlot)) / RAD;
  if (Number.isFinite(data.flip.target_flip_deg) && Math.abs(guideTurn(pressQ) - data.flip.target_flip_deg) > 1e-6) {
    throw Error('翻转连杆与当前装配角度不一致');
  }

  function carrier(flip, wormAngle) {
    const half = 9.45, one = 8 * Math.PI, blend = Math.PI / 2, cycle = 2 * one;
    const slope = 2 * half / (one - blend);
    const phase = one / 2 + (flip - wormAngle) * RAD;
    let v = (phase % cycle + cycle) % cycle;
    const direction = v > one ? -1 : 1;
    if (direction < 0) v = cycle - v;
    const smooth = t => 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
    const integral = t => 2.5 * t ** 4 - 3 * t ** 5 + t ** 6;
    let z, dz;
    if (v < blend) {
      z = -half + slope * blend * integral(v / blend);
      dz = slope * smooth(v / blend);
    } else if (v > one - blend) {
      const t = (one - v) / blend;
      z = half - slope * blend * integral(t);
      dz = slope * smooth(t);
    } else {
      z = -half + slope * (v - blend / 2);
      dz = slope;
    }
    return { z, yaw: (Math.atan2(direction * dz, 1.8) - Math.atan2(slope, 1.8)) / RAD };
  }

  function pose() {
    if (poseState === state) return cachedPose;
    const { clutch, drive } = state;
    const flip = guideTurn(clutch.q), wormAngle = -ratio * clutch.gamma;
    const { z, yaw } = carrier(flip, wormAngle);
    const turns = (partIds, point, degrees, axis = zAxis) =>
      ({ kind: 'rotate', partIds, point, axis, degrees: degrees % 360 });
    const move = (partIds, vector) => ({ kind: 'translate', partIds, vector });
    const along = mm => zAxis.map(v => v * mm);
    const pawlShift = cadVector(datum, [...clutch.ear_pin_xy_old_mm.map((v, i) => v - contactOrigin.ear_pin_xy_old_mm[i]), 0]);
    const key = clutch.q + ':' + clutch.phi;
    if (!lastFlex || lastFlex.key !== key) {
      lastFlex = { key, partId: roles.spring, base: baselineSpring,
        points: key === baselineFlexKey ? baselineSpring : centerline(clutch, datum),
        wireRadiusMm };
    }
    if (compressionLift !== drive.yokeLift) {
      compressionLift = drive.yokeLift;
      compressed = compressionSprings.map(({ partId, centerlineMm: base, axis, liftWeight, wireRadiusMm }) => ({
        key: 'yoke:' + compressionLift, partId, base, wireRadiusMm,
        points: compressionLift ? base.map((point, i) => point.map((v, j) => v + axis[j] * liftWeight[i] * compressionLift)) : base,
      }));
    }
    poseState = state;
    cachedPose = {
      operations: [
        turns(roles.main, main, clutch.gamma), turns(roles.spool, cam, drive.spoolDeg),
        turns(roles.pinion, cam, drive.pinionDeg), move(roles.pinion, along(drive.pinionLift)),
        turns(roles.input, cam, clutch.q), move(roles.yoke, along(drive.yokeLift)),
        turns(roles.worm, worm, wormAngle), turns(roles.follower, worm, yaw, followerAxis),
        turns(roles.guide, worm, flip), move(roles.guide, along(z)), turns(roles.sleeve, worm, flip),
        turns(roles.pawl, pivot, clutch.phi - contactOrigin.phi), move(roles.pawl, pawlShift),
      ],
      flex: lastFlex,
      compressionSprings: compressed,
      wormAngle,
      flip,
    };
    return cachedPose;
  }
  reset();
  return { advance, reset, pose, clutchIsReset, canReverseSpool, windSpool,
    get state() { return state; }, pressQ, plateRate, plateStopTolerance, passivePlate, controlsVersion };
}

function operationSummary(sim) {
  const { clutch, drive } = sim.state;
  const { wormAngle, flip } = sim.pose();
  const coupling = drive.awaitAxialThrust ? '销槽已对合，待正向摇臂完成落座' :
    drive.inserting ? '销槽已对合，正在落座' : drive.leadInSpring ? '压簧沿导入斜面拨动线杯' :
      drive.engaged ? '线杯已接合' : drive.dogContact === 'lead-in' ? '销进入导入斜面，等待落座' :
        drive.waiting ? '等待线杯销槽对合' : '线杯可独立转动';
  return {
    coupling,
    phase: spinPhase(clutch.gamma),
    gamma: clutch.gamma,
    spool: spinPhase(drive.spoolDeg),
    spoolTotal: drive.spoolDeg,
    cam: -clutch.q,
    pawl: clutch.phi,
    worm: spinPhase(wormAngle),
    flip,
    lift: drive.pinionLift,
    yoke: drive.yokeLift,
    event: typeof clutch.event === 'string' ? clutch.event : clutch.event?.label,
    blocked: clutch.blocked,
  };
}

return { createOperationState, operationSummary };
})();

const opContact = (() => {

const RAD = Math.PI / 180;
const EPS = 1e-10;
const LOW = 0, HIGH = -27;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const scale = (a, t) => [a[0] * t, a[1] * t];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const norm = a => Math.hypot(a[0], a[1]);
const angle = a => Math.atan2(a[1], a[0]);
const rotate = (a, rad) => {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c * a[0] - s * a[1], s * a[0] + c * a[1]];
};
const mod = (x, period) => ((x % period) + period) % period;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const edges = points => points.map((p, i) => [p, points[(i + 1) % points.length]]);
const camHeight = q => 8.6 * Math.tan(48 * RAD) * -q * RAD;
const camTarget = q => q > LOW - 1e-9 ? LOW : q < HIGH + 1e-9 ? HIGH : q;

function bounds(points, extra = 0) {
  return [Math.min(...points.map(p => p[0])) - extra, Math.min(...points.map(p => p[1])) - extra,
          Math.max(...points.map(p => p[0])) + extra, Math.max(...points.map(p => p[1])) + extra];
}

function edgeHitsBox([a, b], [x0, y0, x1, y1]) {
  return Math.min(a[0], b[0]) <= x1 && Math.max(a[0], b[0]) >= x0 &&
    Math.min(a[1], b[1]) <= y1 && Math.max(a[1], b[1]) >= y0;
}

function distanceToEdge(p, [a, b]) {
  const d = sub(b, a), v = sub(p, a);
  return norm(sub(v, scale(d, clamp(dot(v, d) / (dot(d, d) || 1), 0, 1))));
}

function inside(p, polygonEdges) {
  let within = false;
  for (const [a, b] of polygonEdges) {
    const d = sub(b, a), v = sub(p, a);
    if (Math.abs(cross(d, v)) < EPS && dot(v, sub(p, b)) <= EPS) return false;
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
        p[0] < a[0] + (p[1] - a[1]) * d[0] / d[1]) within = !within;
  }
  return within;
}

function straddles(a, b, c, d) {
  const direction = sub(b, a);
  const first = cross(direction, sub(c, a)), second = cross(direction, sub(d, a));
  return (first > EPS && second < -EPS) || (second > EPS && first < -EPS);
}

function overlap(points, gear, localEdges) {
  const headEdges = edges(points);
  return points.some(gear.inside) || localEdges.some(([a, b]) =>
    inside(a, headEdges) || inside(b, headEdges) || headEdges.some(([c, d]) =>
      straddles(a, b, c, d) && straddles(c, d, a, b)));
}

function overlapArea(points, gear, stopAt = Infinity) {
  const [x0, y0, x1, y1] = bounds(points);
  const [cx, cy] = gear.center;
  let area = 0;
  for (const [a, b] of gear.edges) {
    if (Math.min(cx, a[0], b[0]) > x1 || Math.max(cx, a[0], b[0]) < x0 ||
        Math.min(cy, a[1], b[1]) > y1 || Math.max(cy, a[1], b[1]) < y0) continue;
    let region = points;
    for (const [p, q] of [[gear.center, a], [a, b], [b, gear.center]]) {
      if (region.length < 3) break;
      const v = sub(q, p), prior = region;
      region = [];
      for (let j = 0; j < prior.length; j++) {
        const u = prior[j], w = prior[(j + 1) % prior.length];
        const f = -cross(v, sub(u, p)), g = -cross(v, sub(w, p));
        if (f >= 0) region.push(u);
        if ((f < 0) !== (g < 0)) region.push(add(u, scale(sub(w, u), f / (f - g))));
      }
    }
    if (region.length >= 3) {
      const r = region[0];
      let s = 0;
      for (let j = 2; j < region.length; j++) s += cross(sub(region[j - 1], r), sub(region[j], r));
      area += Math.abs(s) / 2;
      if (area > stopAt) return area;
    }
  }
  return area;
}

function circleHits(a, b, radius2, hit) {
  const v = sub(b, a), aa = dot(v, v);
  if (aa < EPS ** 2) return;
  const bb = dot(a, v), discriminant = bb * bb - aa * (dot(a, a) - radius2);
  if (discriminant < -EPS) return;
  const root = Math.sqrt(Math.max(0, discriminant));
  for (const t of [(-bb - root) / aa, (-bb + root) / aa]) {
    if (t >= -EPS && t <= 1 + EPS) hit(add(a, scale(v, t)));
  }
}

function minimize(cost, a, b, n = 22) {
  const r = (Math.sqrt(5) - 1) / 2;
  let x = b - (b - a) * r, y = a + (b - a) * r, fx = cost(x), fy = cost(y);
  for (let i = 0; i < n; i++) {
    if (fx <= fy) {
      b = y; y = x; fy = fx;
      x = b - (b - a) * r; fx = cost(x);
    } else {
      a = x; x = y; fx = fy;
      y = a + (b - a) * r; fy = cost(y);
    }
  }
  return fx <= fy ? x : y;
}

function makeClutchContact(data, { plateRateDegPerSec = 5 } = {}) {
  if (!Number.isFinite(plateRateDegPerSec) || plateRateDegPerSec <= 0) throw new TypeError('Plate rate must be positive.');
  const { center: cam, pivotLowRelative, lowPhi } = data.cam;
  const { center: disc, outline } = data.reset;
  const { foot, hole, head, sleeveRadius } = data.pawl;
  const { fixedHole, armA, armB, radiusFree, alphaFree, turnsFree, k } = data.spring;
  const yokePack = data.yokeSpringPack;
  const footR = norm(foot), footA = angle(foot), headEdges = edges(head);
  const headR = Math.max(...head.map(norm));
  const discVectors = outline.map(p => sub(p, disc));
  const polarStart = angle(discVectors[0]);
  const polar = discVectors.map(p => mod(polarStart - angle(p), 2 * Math.PI));
  if (polar.some((v, i) => i && v <= polar[i - 1])) throw new Error('Reset outline must be clockwise and star-shaped about its axle.');
  const discRadii = discVectors.map(norm), discOuter = Math.max(...discRadii), discRoot = Math.min(...discRadii);
  const rootArcs = discRadii.map((r, i) => r < discRoot + 2e-7 && discRadii[(i + 1) % discRadii.length] < discRoot + 2e-7);
  const headSense = Math.sign(headEdges.reduce((area, [a, b]) => area + cross(a, b), 0));
  const pivot = q => add(cam, rotate(pivotLowRelative, q * RAD));
  const sleeve = (p, phi) => add(p, rotate(foot, phi * RAD));
  const old = ([x, y]) => [y - cam[1], cam[0] - x];
  const headAt = (p, phi) => head.map(v => add(p, rotate(v, phi * RAD)));
  const radius = a => radiusFree * turnsFree / (turnsFree + (alphaFree - a) / (2 * Math.PI));
  const span = a => {
    const c = Math.cos(a / 2), s = Math.sin(a / 2);
    return Math.hypot(2 * radius(a) * c + (armA + armB) * s, (armB - armA) * c);
  };
  const spanSlope = a => {
    const c = Math.cos(a / 2), s = Math.sin(a / 2), r = radius(a);
    const rp = r / (2 * Math.PI * turnsFree + alphaFree - a);
    const u = 2 * r * c + (armA + armB) * s, v = (armB - armA) * c;
    const du = 2 * rp * c - r * s + (armA + armB) * c / 2, dv = -(armB - armA) * s / 2;
    return (u * du + v * dv) / Math.hypot(u, v);
  };
  const alphaStep = 2.8 / 256, spanSamples = Array.from({ length: 257 }, (_, i) => span(-.2 + i * alphaStep));
  const radiusAngle = length => {
    let i = 0, j = spanSamples.length - 1;
    if (length <= spanSamples[i]) return -.2;
    if (length >= spanSamples[j]) return 2.6;
    while (j - i > 1) {
      const m = (i + j) >> 1;
      if (spanSamples[m] < length) i = m;
      else j = m;
    }
    const a = -.2 + alphaStep * (i + (length - spanSamples[i]) / (spanSamples[j] - spanSamples[i]));
    return a + (length - span(a)) / spanSlope(a);
  };

  function springAt(p, phi) {
    const h = rotate(hole, phi * RAD), movingHole = add(p, h), v = sub(movingHole, fixedHole);
    const len = norm(v), a = radiusAngle(len), c = Math.cos(a / 2), s = Math.sin(a / 2), R = radius(a);
    const endA = [-R * c - armA * s, armA * c - R * s];
    const endB = [R * c + armB * s, armB * c - R * s];
    const yaw = angle(v) - angle(sub(endB, endA)), coil = sub(fixedHole, rotate(endA, yaw));
    const F = k * (alphaFree - a) / spanSlope(a), force = scale(v, F / len);
    return {
      R, N: turnsFree + (alphaFree - a) / (2 * Math.PI), angle: yaw, alpha_deg: a / RAD, F,
      C: coil, coil_xy_old_mm: old(coil), fixed_leg_xy_old_mm: old(fixedHole), pawl_leg_xy_old_mm: old(movingHole),
      torque_pawl: cross(h, force), torque_cam: cross(sub(p, cam), force), energy: .5 * k * (alphaFree - a) ** 2,
    };
  }

  const energy = (p, phi) => .5 * k * (alphaFree - radiusAngle(norm(sub(add(p, rotate(hole, phi * RAD)), fixedHole)))) ** 2;
  function yokeEnergy(q, floor) {
    if (!yokePack) return 0;
    const nominal = Math.max(0, Math.min(camHeight(q), 3.47) - .073523674529);
    const compression = yokePack.lowCompression + Math.max(nominal, floor);
    return .5 * yokePack.count * yokePack.rateEach * (compression ** 2 - yokePack.lowCompression ** 2);
  }

  function gearAt(gamma) {
    const phi = mod(gamma, 360) * RAD, c = Math.cos(phi), s = Math.sin(phi);
    const points = discVectors.map(([x, y]) => [disc[0] + c * x - s * y, disc[1] + s * x + c * y]);
    const pointInside = p => {
      const v = sub(p, disc), r = norm(v);
      if (r > discOuter) return false;
      if (r < 1e-12) return true;
      const u = [c * v[0] + s * v[1], c * v[1] - s * v[0]];
      const t = mod(polarStart - angle(u), 2 * Math.PI);
      let i = 0, j = polar.length;
      while (j - i > 1) {
        const m = (i + j) >> 1;
        if (polar[m] <= t) i = m;
        else j = m;
      }
      const a = discVectors[i], b = discVectors[j % polar.length];
      return cross(a, b) / cross(u, sub(b, a)) > 1 + 1e-11;
    };
    return { edges: edges(points), inside: pointInside, center: disc };
  }

  function stopGaps(p, phi) {
    const c = sleeve(p, phi);
    return data.shoulders.map(({ endpoint, normal, arc, relief }) => [
      Math.max(dot(sub(c, endpoint), normal), relief ? dot(sub(c, relief.endpoint), relief.normal) : -Infinity),
      arc.sign * (norm(sub(c, arc.pivot)) - footR),
    ]);
  }

  function finiteClearance(p, phi) {
    const c = sleeve(p, phi);
    return data.shoulders.map(({ guide, arc }, index) => {
      const v = sub(c, arc.pivot), r = norm(v), bearing = mod((angle(v) - footA) / RAD + 180, 360) - 180;
      let arcGap = Math.max(0, arc.inner - r, r - arc.outer);
      if (bearing < arc.startDeg || bearing > arc.endDeg) {
        arcGap = Math.min(...[arc.startDeg, arc.endDeg].map(t => {
          const a = footA + t * RAD, u = [Math.cos(a), Math.sin(a)];
          return norm(sub(v, scale(u, clamp(dot(v, u), arc.inner, arc.outer))));
        }));
      }
      const profiles = index === 0 ? [guide, data.bridge] : [guide];
      const guideGap = Math.min(...profiles.map(profile => {
        const es = edges(profile);
        return inside(c, es) ? 0 : Math.min(...es.map(e => distanceToEdge(c, e)));
      }));
      return Math.min(guideGap, arcGap) - sleeveRadius;
    });
  }

  function intervals(p, gear, lo, hi) {
    const candidates = [lo, hi], pad = headR * ((hi - lo) * RAD) ** 2 / 8 + 1e-8;
    const limits = bounds([...headAt(p, lo), ...headAt(p, hi)], pad);
    const local = gear.edges.filter(e => edgeHitsBox(e, limits));
    const addAngle = a => {
      const t = mod(a / RAD + 180, 360) - 180;
      if (t > lo && t < hi) candidates.push(t);
    };
    const around = (a, c) => {
      if (Math.abs(c) <= 1) {
        const b = Math.acos(c);
        addAngle(a - b); addAngle(a + b);
      }
    };
    for (const [wa, wb] of local) {
      const a = sub(wa, p), b = sub(wb, p);
      for (const v of head) circleHits(a, b, dot(v, v), z => addAngle(angle(z) - angle(v)));
      for (const v of [a, b]) {
        for (const [u, w] of headEdges) circleHits(u, w, dot(v, v), z => addAngle(angle(v) - angle(z)));
      }
    }
    for (const { endpoint, normal, arc, relief } of data.shoulders) {
      around(angle(normal) - footA, dot(sub(endpoint, p), normal) / footR);
      if (relief) around(angle(relief.normal) - footA, dot(sub(relief.endpoint, p), relief.normal) / footR);
      const delta = sub(p, arc.pivot);
      if (norm(delta) > 1e-9) around(angle(delta) - footA, -norm(delta) / (2 * footR));
    }
    candidates.sort((a, b) => a - b);
    const feasible = [];
    for (let i = 1; i < candidates.length; i++) {
      const a = candidates[i - 1], b = candidates[i], phi = (a + b) / 2;
      if (b - a < 1e-9 || stopGaps(p, phi).flat().some(gap => gap < -EPS) || overlap(headAt(p, phi), gear, local)) continue;
      if (feasible.length && Math.abs(feasible.at(-1)[1] - a) < 1e-8) feasible.at(-1)[1] = b;
      else feasible.push([a, b]);
    }
    return feasible;
  }

  function best(p, gear, phi, width, cost) {
    let winner = { score: Infinity, phi };
    for (const [a, b] of intervals(p, gear, phi - width, phi + width)) {
      for (const option of [a, b, minimize(cost, a, b)]) {
        const score = cost(option);
        if (score < winner.score) winner = { score, phi: option };
      }
    }
    return winner;
  }

  function acceptableSegment(before, after, heldGear) {
    for (const t of [.25, .5, .75]) {
      const q = before.q + t * (after.q - before.q), phi = before.phi + t * (after.phi - before.phi);
      const p = pivot(q);
      if (Math.min(...finiteClearance(p, phi)) < -1e-5) return false;
      const gear = heldGear ?? gearAt(before.gamma + t * (after.gamma - before.gamma));
      const points = headAt(p, phi), box = bounds(points);
      const local = gear.edges.filter(e => edgeHitsBox(e, box));
      if (overlap(points, gear, local) && overlapArea(points, gear, 2e-5) >= 2e-5) return false;
    }
    return true;
  }

  function atLow({ q, phi }) {
    return Math.abs(q) < 1e-7 && Math.abs(phi - lowPhi) < 1e-5;
  }

  function pose(q, phi, gamma, steps = [], blocked = null) {
    const p = pivot(q), gear = gearAt(gamma), points = headAt(p, phi), box = bounds(points, .005);
    const near = gear.edges.filter(e => edgeHitsBox(e, box));
    const toothGap = Math.min(Infinity, ...near.flatMap(e => points.map(v => distanceToEdge(v, e))),
      ...edges(points).flatMap(e => near.flatMap(([a, b]) => [distanceToEdge(a, e), distanceToEdge(b, e)])));
    const contact = toothGap < .001;
    return {
      q, phi, gamma, steps, blocked, highPlatform: camHeight(q) >= 3.47,
      event: atLow({ q, phi }) ? 'low-stop' : Math.abs(q - HIGH) < 1e-7 ? (contact ? 'high-tooth' : 'high-stop') : (contact ? 'tooth-drive' : 'transition'),
      contact,
      ear_pin_xy_old_mm: old(p), sleeve_xy_old_mm: old(sleeve(p, phi)), stop_gap_mm: finiteClearance(p, phi),
      spring: springAt(p, phi),
    };
  }

  function advancePlate(state, targetQ) {
    if (!Number.isFinite(targetQ)) throw new TypeError('Plate target must be finite.');
    targetQ = camTarget(targetQ);
    const gamma = state.gamma, gear = gearAt(gamma), steps = [];
    let { q, phi } = state;
    while (Math.abs(targetQ - q) > 1e-9 && steps.length < 4000) {
      const sign = Math.sign(targetQ - q);
      let ds = Math.min(.1, Math.abs(targetQ - q)), next;
      const minStep = Math.min(1e-5, ds / 2);
      while (ds >= minStep) {
        const nextQ = q + sign * ds, p = pivot(nextQ);
        const cost = t => energy(p, t) + (.025 * plateRateDegPerSec / ds) * ((t - phi) * RAD) ** 2;
        const opt = best(p, gear, phi, 2, cost);
        next = { q: nextQ, phi: opt.phi, gamma };
        if (Number.isFinite(opt.score) && Math.abs(next.phi - phi) <= .25 && acceptableSegment({ q, phi, gamma }, next, gear)) break;
        ds /= 2;
      }
      if (ds < minStep) return pose(q, phi, gamma, steps, 'plate-contact');
      ({ q, phi } = next);
      steps.push(next);
    }
    if (Math.abs(targetQ - q) > 1e-8) return pose(q, phi, gamma, steps, 'plate-step-budget');
    if (q !== targetQ) {
      q = targetQ;
      steps.push({ q, phi, gamma });
    }
    if (q === LOW || q === HIGH) {
      const p = pivot(q);
      // Relax on the connected interval only. A settled pawl cannot skip a tooth.
      for (let i = 0; i < 120; i++) {
        const region = intervals(p, gear, phi - .25, phi + .25).find(([a, b]) => a - 1e-7 <= phi && phi <= b + 1e-7);
        if (!region) break;
        const [a, b] = region, cost = t => energy(p, t);
        const nextPhi = [a, b, minimize(cost, a, b)].sort((x, y) => cost(x) - cost(y))[0];
        if (Math.abs(nextPhi - phi) < 1e-8) break;
        phi = nextPhi;
        steps.push({ q, phi, gamma });
      }
    }
    return pose(q, phi, gamma, steps);
  }

  const clearGear = { edges: [], inside: () => false, center: disc };

  function positiveGearContact(p, phi, gear) {
    const gap = .0002, momentArm = .02;
    const points = headAt(p, phi), perimeter = edges(points), box = bounds(points, gap);
    function positiveContact(vertex, a, b, sense, gearVertex) {
      const d = sub(b, a), length = norm(d), projection = dot(sub(vertex, a), d) / (length ** 2);
      if (projection < -1e-7 || projection > 1 + 1e-7) return false;
      const location = add(a, scale(d, clamp(projection, 0, 1)));
      if (norm(sub(vertex, location)) > gap) return false;
      const force = scale([-d[1], d[0]], sense / length);
      return cross(sub(gearVertex ? vertex : location, disc), force) > momentArm;
    }
    return gear.edges.some(([a, b], i) => {
      if (!edgeHitsBox([a, b], box)) return false;
      // The exact root is a concentric cylinder. Chords in its sampled outline cannot supply shaft torque.
      if (!rootArcs[i] && points.some(v => positiveContact(v, a, b, -1, false))) return true;
      if (rootArcs[i] && rootArcs[(i + rootArcs.length - 1) % rootArcs.length]) return false;
      return perimeter.some(([u, v]) => positiveContact(a, u, v, -headSense, true));
    });
  }

  function freePlateStep(state, q, weight, shaftDrag, phiWidth) {
    const p = pivot(q), { phi, gamma } = state;
    const pawlCost = t => energy(p, t) + weight * ((t - phi) * RAD) ** 2;
    const unconstrained = best(p, clearGear, phi, phiWidth, pawlCost);
    const currentGear = gearAt(gamma);
    let canDrive;
    const at = t => {
      const gear = t === gamma ? currentGear : gearAt(t);
      const opt = best(p, gear, phi, phiWidth, pawlCost);
      const rotation = (t - gamma) * RAD;
      if (rotation > EPS && Number.isFinite(opt.score)) {
        canDrive ??= positiveGearContact(pivot(state.q), phi, currentGear);
        if (!canDrive && !positiveGearContact(p, opt.phi, gear)) return { q, phi: opt.phi, gamma: t, score: Infinity };
      }
      return { q, phi: opt.phi, gamma: t, score: opt.score + weight * rotation ** 2 + shaftDrag * rotation };
    };
    const fixed = at(gamma);
    if (Number.isFinite(fixed.score) && fixed.score <= unconstrained.score + 1e-11) return fixed;

    const tested = [fixed, ...Array.from({ length: 8 }, (_, i) => at(gamma + (i + 1) * .03))];
    let j = 0;
    for (let i = 1; i < tested.length; i++) if (tested[i].score < tested[j].score - 1e-11) j = i;
    if (!Number.isFinite(tested[j].score)) return tested[j];
    const a = tested[Math.max(0, j - 1)].gamma, b = tested[Math.min(tested.length - 1, j + 1)].gamma;
    const refined = at(minimize(t => at(t).score, a, b));
    return refined.score < tested[j].score - 1e-11 ? refined : tested[j];
  }

  function advanceFreePlate(state, targetQ, { shaftDragNmm = 0 } = {}) {
    if (!Number.isFinite(targetQ) || !Number.isFinite(shaftDragNmm) || shaftDragNmm < 0) throw new TypeError('Finite plate target and nonnegative shaft drag required.');
    targetQ = camTarget(targetQ);
    let current = { q: state.q, phi: state.phi, gamma: state.gamma };
    const steps = [];
    const finish = blocked => ({ ...pose(current.q, current.phi, current.gamma, steps, blocked),
      motionInput: 'plate', passiveMainDeltaDeg: current.gamma - state.gamma });

    function accept(next) {
      current = { q: next.q, phi: next.phi, gamma: next.gamma };
      steps.push(current);
    }

    function relaxAtFixedCam() {
      const next = freePlateStep(current, current.q, 1.25, shaftDragNmm, .24);
      const previousEnergy = energy(pivot(current.q), current.phi);
      if (next.score >= previousEnergy - 1e-10 || !acceptableSegment(current, next)) return false;
      accept(next);
      return true;
    }

    while (Math.abs(targetQ - current.q) > 1e-9 && steps.length < 4000) {
      const sign = Math.sign(targetQ - current.q);
      let ds = Math.min(.1, Math.abs(targetQ - current.q)), next;
      const minStep = Math.min(1e-5, ds / 2);
      while (ds >= minStep) {
        next = freePlateStep(current, current.q + sign * ds, .025 * plateRateDegPerSec / ds, shaftDragNmm, 2);
        if (Number.isFinite(next.score) && Math.abs(next.phi - current.phi) <= .25 && acceptableSegment(current, next)) break;
        ds /= 2;
      }
      if (ds < minStep) {
        if (relaxAtFixedCam()) continue;
        return finish('plate-contact');
      }
      accept(next);
    }
    if (Math.abs(targetQ - current.q) > 1e-8) return finish('plate-step-budget');
    if (current.q !== targetQ) accept({ ...current, q: targetQ });
    if (current.q === LOW || current.q === HIGH) {
      for (let i = 0; i < 400; i++) if (!relaxAtFixedCam()) break;
    }
    return finish(null);
  }

  function releaseHigh(state, { shaftDragNmm = 0 } = {}) {
    if (state.q !== HIGH) return { ...pose(state.q, state.phi, state.gamma, [], state.blocked ?? null), motionInput: 'plate', passiveMainDeltaDeg: 0 };
    const potential = s => energy(pivot(s.q), s.phi) + yokeEnergy(s.q, 0);
    let current = state, ds = .01;
    const steps = [];
    while (ds >= 1e-5 && steps.length < 4000) {
      const before = potential(current);
      const candidates = [-1, 1].map(direction => {
        const q = clamp(current.q + direction * ds, HIGH, LOW);
        if (q === current.q) return null;
        const next = advanceFreePlate(current, q, { shaftDragNmm });
        let last = before;
        for (const step of next.steps) {
          const u = potential(step);
          if (u > last + 1e-10) return null;
          last = u;
        }
        const cost = last + shaftDragNmm * (next.gamma - current.gamma) * RAD;
        return !next.blocked && cost < before - 1e-11 ? { next, cost } : null;
      }).filter(Boolean).sort((a, b) => a.cost - b.cost);
      if (!candidates.length) {
        ds /= 2;
        continue;
      }
      current = candidates[0].next;
      steps.push(...current.steps);
    }
    const final = pose(current.q, current.phi, current.gamma, steps, steps.length >= 4000 ? 'plate-release-budget' : null);
    return { ...final, motionInput: 'plate', passiveMainDeltaDeg: current.gamma - state.gamma };
  }

  function driveStep(state, gamma, ds, gear, yokeFloor) {
    const { q, phi } = state;
    function at(nextQ) {
      const p = pivot(nextQ);
      const load = yokeEnergy(nextQ, yokeFloor);
      const cost = t => energy(p, t) + load + .125 / ds * (((nextQ - q) * RAD) ** 2 + ((t - phi) * RAD) ** 2);
      return { q: nextQ, gamma, ...best(p, gear, phi, .24, cost) };
    }
    if (q === HIGH) {
      const held = at(HIGH), released = at(HIGH + .001);
      if (Number.isFinite(held.score) && released.score >= held.score) return held;
    }
    const grid = Array.from({ length: 13 }, (_, i) => q + (i - 6) * .04);
    for (const ref of [LOW, HIGH]) if (Math.abs(ref - q) <= .24) grid.push(ref);
    const candidates = [...new Set(grid)].sort((a, b) => a - b).map(at);
    let i = 0;
    for (let j = 1; j < candidates.length; j++) if (candidates[j].score < candidates[i].score) i = j;
    const nearest = candidates[i];
    if (!Number.isFinite(nearest.score)) return nearest;
    const left = candidates[Math.max(0, i - 1)].q, right = candidates[Math.min(i + 1, candidates.length - 1)].q;
    const refined = at(minimize(x => at(x).score, left, right, 27));
    return refined.score < nearest.score ? refined : nearest;
  }

  function advanceCrank(state, targetGamma, { yokeFloor = () => 0 } = {}) {
    if (!Number.isFinite(targetGamma)) throw new TypeError('Crank target must be finite.');
    let current = { q: state.q, phi: state.phi, gamma: state.gamma };
    const steps = [];
    let increment = .1;
    if (targetGamma < current.gamma - 1e-9) return pose(current.q, current.phi, current.gamma, steps, 'one-way-bearing');
    while (targetGamma - current.gamma > 1e-9 && steps.length < 5000) {
      if (atLow(current)) {
        current = { q: LOW, phi: lowPhi, gamma: targetGamma };
        steps.push(current);
        break;
      }
      let ds = Math.min(increment, targetGamma - current.gamma), next;
      const minStep = Math.min(1e-5, ds / 2);
      while (ds >= minStep) {
        const gamma = current.gamma + ds;
        const floor = yokeFloor(gamma);
        if (!Number.isFinite(floor) || floor < 0) throw new TypeError('Yoke floor must be finite and nonnegative.');
        const opt = driveStep(current, gamma, ds, gearAt(gamma), floor);
        next = { q: opt.q, phi: opt.phi, gamma };
        if (Number.isFinite(opt.score) && Math.abs(next.q - current.q) <= .25 && Math.abs(next.phi - current.phi) <= .25 &&
            acceptableSegment(current, next)) break;
        ds /= 2;
      }
      if (ds < minStep) return pose(current.q, current.phi, current.gamma, steps, 'drive-contact');
      increment = Math.min(.1, ds * 1.5);
      current = next;
      steps.push(current);
    }
    const blocked = targetGamma - current.gamma > 1e-8 ? 'drive-step-budget' : null;
    return pose(current.q, current.phi, current.gamma, steps, blocked);
  }

  function check(q, phi, gamma) {
    const p = pivot(q);
    return { stopGapMm: finiteClearance(p, phi), gearOverlapMm2: overlapArea(headAt(p, phi), gearAt(gamma)) };
  }

  return { initial: (gamma = 0) => pose(LOW, lowPhi, gamma), advancePlate, advanceFreePlate, releaseHigh, advanceCrank, pose, check };
}

return { makeClutchContact };
})();

const opCoupling = (() => {

const RAD = Math.PI / 180;
const RAMP = 8.6 * Math.tan(48 * RAD) * RAD;
const LOST = .073523674529 + .351925111495;
const HELIX_DEG_PER_MM = -6.981748456846341;
const CLEAR_LIFT_MM = 2.270000300001388;
const YOKE_CLIP_FREE_RISE_MM = .2;
const SLOT_PERIOD_DEG = 90;
const SLOT_CAPTURE_HALF_ANGLE_DEG = .9569;
const GEAR_RATIO = 184 / 25;
const Q_CLEAR = -(CLEAR_LIFT_MM + LOST) / RAMP;
const EPS = 1e-9;

/* GENERATED PROFILE BEGIN */
const DOG_PROFILE = [
  [0, 0.959195500235572],
  [0.9569, 1.28790495529864],
  [0.9571, 1.28890495529864],
  [0.95728125, 1.31744621883625],
  [0.9574625, 1.3213256138802],
  [0.95764375, 1.32409661034016],
  [0.957825, 1.32465080963216],
  [0.9581875, 1.32797600538411],
  [0.95855, 1.32936150361409],
  [0.96, 1.336011895118],
  [0.97, 1.37272759821251],
  [0.985, 1.42634637971279],
  [1, 1.47830256333708],
  [1.015625, 1.53095149607637],
  [1.01953125, 1.5435595299692],
  [1.0234375, 1.55298091793308],
  [1.02734375, 1.55963130943699],
  [1.03125, 1.56503475253392],
  [1.0390625, 1.5739019412058],
  [1.046875, 1.5812450818247],
  [1.0625, 1.59343746624853],
  [1.078125, 1.6035516033274],
  [1.09375, 1.61241879199928],
  [1.125, 1.62765927252907],
  [1.15625, 1.64082150571389],
  [1.1875, 1.65245969084574],
  [1.25, 1.67296506464946],
  [1.3125, 1.69069944199322],
  [1.375, 1.70663267163801],
  [1.5, 1.73461973588363],
  [1.625, 1.7590045047313],
  [1.75, 1.78061827711901],
  [1.875, 1.80043090180774],
  [2, 1.81871947844349],
  [2.25, 1.85169433631705],
  [2.5, 1.88092834896966],
  [2.75, 1.9072528153393],
  [3, 1.93149903436397],
  [3.25, 1.95366700604367],
  [3.5, 1.9743109296704],
  [4, 2.01171938187989],
  [4.5, 2.04455568993045],
  [5, 2.07392825240605],
  [5.375, 2.09387942691778],
  [5.75, 2.11244510319953],
  [6.125, 2.1294867314283],
  [6.5, 2.14528141125009],
  [7.25, 2.17326847549571],
  [8, 2.19709904505139],
  [8.5, 2.2109540273512],
  [9, 2.22314641177504],
  [9.5, 2.23395329796889],
  [10, 2.24323613610977],
  [10.5, 2.25113347602066],
  [11, 2.25764531770157],
  [11.5, 2.2629102109755],
  [12, 2.26692815584245],
  [12.5, 2.26969915230241],
  [13, 2.27000030000139],
  [14, 2.27000030000139],
  [16, 2.27000030000139],
  [22, 2.27000030000139],
  [23.5, 2.27000030000139],
  [24.25, 2.27000030000139],
  [25, 2.26665105619645],
  [25.75, 2.25986211486955],
  [26.5, 2.25016362725968],
  [28, 2.22868840469497],
  [32, 2.16883488115977],
  [36, 2.10537906222663],
  [40.5, 2.03014650833864],
  [42.75, 1.99107545825317],
  [43.3125, 1.9810998709973],
  [43.875, 1.97334108090941],
  [45, 1.9593475487866],
  [54, 1.84753784162711],
  [62, 1.74972166659042],
  [70, 1.6555077869517],
  [74, 1.6103405446543],
  [74.5, 1.60479855173438],
  [74.75, 1.60202755527442],
  [74.8125, 1.60133480615943],
  [74.84375, 1.60092015669043],
  [74.8515625, 1.60091915669043],
  [74.859375, 1.59814916023047],
  [74.875, 1.59814816023047],
  [75, 1.59717831146948],
  [76, 1.5883111227976],
  [77, 1.57611873837377],
  [78, 1.56087825784397],
  [78.75, 1.54716182536716],
  [79.5, 1.53136714554537],
  [80.25, 1.51335566855561],
  [81, 1.49298884457489],
  [81.75, 1.4699895739572],
  [82.5, 1.44408075705655],
  [83.25, 1.41498529422694],
  [84, 1.38201043635338],
  [84.375, 1.36386040954063],
  [84.75, 1.34446343432089],
  [85.125, 1.32368096087117],
  [85.5, 1.30123588954547],
  [85.875, 1.2768511206978],
  [86.25, 1.25038810450516],
  [86.625, 1.22101554202955],
  [87, 1.188317783802],
  [87.25, 1.16393301495432],
  [87.5, 1.13705434929269],
  [87.75, 1.1065733882331],
  [87.875, 1.08967030982733],
  [88, 1.07110463354558],
  [88.125, 1.05073780956485],
  [88.25, 1.02746143930116],
  [88.3125, 1.01443775593934],
  [88.375, 1.00016712417053],
  [88.4375, 0.983956794879751],
  [88.5, 0.965391118598001],
  [88.5625, 0.943915896033291],
  [88.625, 0.920639525769605],
  [88.6875, 0.895284908160947],
  [88.75, 0.867713493384319],
  [88.8125, 0.837371082147728],
  [88.875, 0.803980574805178],
  [88.9375, 0.766849222241679],
  [88.96875, 0.746620948083952],
  [89, 0.725145725519241],
  [89.0125, 0.714893038617379],
  [89.025, 0.70228500472455],
  [89.0325, 0.692447967291682],
  [89.03625, 0.68593612561077],
  [89.04, 0.67706893693889],
  [89.04145, 0.671665493841963],
  [89.042175, 0.667647548975017],
  [89.0425375, 0.664183803400063],
  [89.04271875, 0.660304408356116],
  [89.0429, 0.631486045172504],
  [89.0431, 0.630486045172504],
  [90, 0.959195500235572],
];
/* GENERATED PROFILE END */

const yokeLift = q => Math.max(0, Math.min(RAMP * -q, 3.47) - .073523674529);
const nominalPinionLift = q => Math.max(0, yokeLift(q) - .351925111495);
const angle = (gamma, lift) => -GEAR_RATIO * gamma + HELIX_DEG_PER_MM * lift;
const mix = (a, b, t) => a + (b - a) * t;
const mixPose = (a, b, t) => ({ q: mix(a.q, b.q, t), gamma: mix(a.gamma, b.gamma, t) });
const mod = (a, b) => ((a % b) + b) % b;
const fit = relative => Math.abs(mod(relative + SLOT_PERIOD_DEG / 2, SLOT_PERIOD_DEG) - SLOT_PERIOD_DEG / 2) <= SLOT_CAPTURE_HALF_ANGLE_DEG + EPS;

function guardProfile(relativeDeg) {
  const phase = mod(relativeDeg, SLOT_PERIOD_DEG);
  let a = 0, b = DOG_PROFILE.length - 1;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (DOG_PROFILE[m][0] <= phase) a = m;
    else b = m;
  }
  const [p, h] = DOG_PROFILE[a], [q, g] = DOG_PROFILE[b];
  return mix(h, g, (phase - p) / (q - p));
}

const pinionNoseFloor = relativeDeg => fit(relativeDeg) ? 0 : guardProfile(relativeDeg);

function phaseKnots(lo, hi) {
  const points = [];
  for (let i = 0; i < DOG_PROFILE.length - 1; i++) {
    const phase = DOG_PROFILE[i][0];
    const p = phase + SLOT_PERIOD_DEG * Math.ceil((lo - phase) / SLOT_PERIOD_DEG);
    if (p > lo + EPS && p < hi - EPS) points.push(p);
  }
  return points;
}

function followNose(base, prior, goal) {
  if (goal >= CLEAR_LIFT_MM) return { lift: goal, contact: false };
  const start = Math.max(goal, Math.min(prior, CLEAR_LIFT_MM));
  const relative = h => base - HELIX_DEG_PER_MM * h;
  const gap = h => h - guardProfile(relative(h));
  const rising = gap(start) < -EPS;
  const end = rising ? CLEAR_LIFT_MM : goal;
  const lo = relative(Math.min(start, end)), hi = relative(Math.max(start, end));
  const knots = [start, end, ...phaseKnots(lo, hi).map(p => (base - p) / HELIX_DEG_PER_MM)];
  knots.sort(rising ? (a, b) => a - b : (a, b) => b - a);
  let last = knots[0], distance = gap(last);
  for (const h of knots.slice(1)) {
    const next = gap(h);
    if ((rising && next >= -EPS) || (!rising && next < -EPS)) {
      return { lift: Math.min(CLEAR_LIFT_MM, Math.max(goal, mix(last, h, distance / (distance - next)))), contact: true };
    }
    last = h;
    distance = next;
  }
  return { lift: end, contact: Math.abs(gap(end)) <= EPS };
}

function followContactBranch(base, previousBase, previousLift, goal) {
  const relative = previousBase - HELIX_DEG_PER_MM * previousLift;
  if (goal > previousLift + EPS || Math.abs(guardProfile(relative) - previousLift) > 1e-6 || fit(relative)) return null;
  const direction = Math.sign(base - previousBase);
  if (!direction) return { lift: previousLift, contact: true };
  const edge = -direction * SLOT_CAPTURE_HALF_ANGLE_DEG;
  const unit = (relative - edge) / SLOT_PERIOD_DEG;
  const limit = edge + SLOT_PERIOD_DEG * (direction > 0 ? Math.ceil(unit) : Math.floor(unit));
  const points = [limit, ...phaseKnots(Math.min(relative, limit), Math.max(relative, limit))];
  points.sort((a, b) => direction * (a - b));
  let lastAngle = relative, lastBase = previousBase;
  for (const p of points) {
    const projectedBase = p + HELIX_DEG_PER_MM * guardProfile(p);
    if (direction * (base - lastBase) >= -EPS && direction * (projectedBase - base) >= -EPS && Math.abs(projectedBase - lastBase) > EPS) {
      const liftedAngle = mix(lastAngle, p, (base - lastBase) / (projectedBase - lastBase));
      const lift = guardProfile(liftedAngle);
      return lift >= goal - EPS ? { lift, contact: true } : null;
    }
    lastAngle = p;
    lastBase = projectedBase;
  }
  return null;
}

function downNose(relative, lift, floor, travel) {
  const paths = [-1, 1].map(direction => {
    const edge = -direction * SLOT_CAPTURE_HALF_ANGLE_DEG;
    const unit = (relative - edge) / SLOT_PERIOD_DEG;
    const end = edge + SLOT_PERIOD_DEG * (direction > 0 ? Math.ceil(unit) : Math.floor(unit));
    const knots = [end, ...phaseKnots(Math.min(relative, end), Math.max(relative, end))];
    knots.sort((a, b) => direction * (a - b));
    return { end, knots, drop: lift - guardProfile(knots[0]) };
  });
  const { end, knots, drop } = paths.sort((a, b) => b.drop - a.drop)[0];
  if (drop <= EPS || lift <= floor + EPS) return null;

  const steps = [];
  let lastAngle = relative, height = lift;
  for (const phase of knots) {
    const nextHeight = guardProfile(phase);
    if (height - nextHeight <= EPS || travel <= EPS || height <= floor + EPS) break;
    const h = Math.max(floor, height - travel, nextHeight);
    const t = (height - h) / (height - nextHeight);
    lastAngle = mix(lastAngle, phase, t);
    steps.push({ relative: lastAngle, lift: h });
    travel -= height - h;
    height = h;
    if (t < 1 - EPS) break;
  }
  return { steps, travel, enters: Math.abs(lastAngle - end) <= EPS };
}

function springGoal(q, prior) {
  const nominal = nominalPinionLift(q);
  return Math.max(nominal, Math.min(prior, yokeLift(q) + YOKE_CLIP_FREE_RISE_MM));
}

function yokeFloorAt(coupling, gamma) {
  if (!coupling || coupling.engaged) return 0;
  const previousBase = coupling.spoolDeg - coupling.pinionDeg + HELIX_DEG_PER_MM * coupling.pinionLift;
  const base = coupling.spoolDeg + GEAR_RATIO * gamma;
  const { lift } = followContactBranch(base, previousBase, coupling.pinionLift, 0.) ?? followNose(base, coupling.pinionLift, 0.);
  if (fit(base - HELIX_DEG_PER_MM * lift)) return 0;
  return Math.max(0., lift - YOKE_CLIP_FREE_RISE_MM);
}

function initialCoupling(gamma = 0, q = 0) {
  const lift = nominalPinionLift(q), engaged = q > Q_CLEAR;
  return {
    pinionLift: lift, yokeLift: yokeLift(q), pinionDeg: angle(gamma, lift),
    spoolDeg: angle(gamma, engaged ? lift : CLEAR_LIFT_MM), engaged, inserting: false, waiting: false,
    dogContact: engaged ? 'seated' : 'free', awaitAxialThrust: false, pickup: null,
  };
}

function advanceCoupling(prev, fromClutch, toClutch, spoolDeltaDeg = 0, seatStepMm, { holdSpoolOnNose = false } = {}) {
  if (!Number.isFinite(spoolDeltaDeg) || (seatStepMm !== undefined && (!Number.isFinite(seatStepMm) || seatStepMm < 0))) {
    throw new TypeError('Finite rotation and nonnegative seating travel required.');
  }
  const moved = toClutch.q !== fromClutch.q || toClutch.gamma !== fromClutch.gamma;
  const path = moved && toClutch.steps?.length ? toClutch.steps : [toClutch];
  const plateInput = toClutch.motionInput === 'plate';
  const axis = toClutch.gamma !== fromClutch.gamma && (!plateInput || toClutch.q === fromClutch.q) ? 'gamma' : 'q';
  const segments = path.map((to, i) => {
    const from = i ? path[i - 1] : fromClutch;
    return { from, to, extent: Math.abs(to[axis] - from[axis]) };
  });
  const extent = segments.reduce((n, s) => n + s.extent, 0);
  const seatTravel = seatStepMm ?? .25 * (extent || Math.abs(spoolDeltaDeg));
  const current = { ...prev, pickup: null, passiveSpoolDeltaDeg: 0, leadInSteps: [], leadInSpring: false };

  function moveLatched(a, b, seat) {
    const forward = !plateInput && b.gamma > a.gamma + EPS, nominal = nominalPinionLift(b.q);
    const target = forward ? nominal : springGoal(b.q, current.pinionLift);
    const lift = Math.max(target, current.pinionLift - seat);
    const nextAngle = angle(b.gamma, lift);
    current.spoolDeg += nextAngle - current.pinionDeg;
    current.pinionDeg = nextAngle;
    current.pinionLift = lift;
    current.engaged = b.q > Q_CLEAR;
    current.waiting = false;
    current.leadInSpring = false;
    current.inserting = lift > target + EPS;
    current.awaitAxialThrust = current.engaged && !forward && !current.inserting && yokeLift(b.q) < EPS && lift > nominal + EPS;
    current.dogContact = current.awaitAxialThrust ? 'await-thrust' : current.inserting ? 'slot-slide' : current.engaged ? 'seated' : 'free';
  }

  function moveSpoolDownNose(state, seat, crankInput) {
    const { spoolDeg, pinionDeg, pinionLift } = current;
    const floor = yokeLift(state.q) + YOKE_CLIP_FREE_RISE_MM;
    // Settle the free cup on the flank before the next crank substep. The seating budget starts at pickup.
    const slide = downNose(spoolDeg - pinionDeg, pinionLift, floor, crankInput ? Infinity : seat);
    if (!slide) return;
    current.leadInSpring = !slide.enters;
    current.dogContact = 'lead-in';
    if (slide.steps.length) current.leadInSteps.push({ ...state, spoolDeg, pinionDeg, lift: pinionLift });
    for (const { relative, lift } of slide.steps) {
      current.pinionLift = lift;
      current.pinionDeg = angle(state.gamma, lift);
      current.spoolDeg = current.pinionDeg + relative;
      current.leadInSteps.push({ ...state, spoolDeg: current.spoolDeg, pinionDeg: current.pinionDeg, lift });
    }
    if (slide.enters) {
      current.engaged = true;
      current.pickup = { gamma: state.gamma, spoolDeg: current.spoolDeg, pinionDeg: current.pinionDeg, lift: current.pinionLift, source: 'lead-in-springs' };
      moveLatched(state, state, crankInput ? seat : slide.travel);
    }
    current.passiveSpoolDeltaDeg += current.spoolDeg - spoolDeg;
  }

  function moveFree(a, b, manual, seat) {
    const spindle = current.spoolDeg, oldLift = current.pinionLift;
    const base0 = spindle + GEAR_RATIO * a.gamma, base1 = spindle + manual + GEAR_RATIO * b.gamma;
    function candidate(t) {
      const state = mixPose(a, b, t), spoolDeg = spindle + manual * t;
      const floor = springGoal(state.q, oldLift);
      const atGuard = angle(state.gamma, CLEAR_LIFT_MM);
      if (oldLift >= CLEAR_LIFT_MM - EPS && floor <= CLEAR_LIFT_MM + EPS && fit(spoolDeg - atGuard)) {
        return { state, lift: CLEAR_LIFT_MM, contact: false, captures: true, spoolDeg, pinionDeg: atGuard };
      }
      const base = spoolDeg + GEAR_RATIO * state.gamma;
      const { lift, contact } = followContactBranch(base, base0, oldLift, floor) ?? followNose(base, oldLift, floor);
      const pinionDeg = angle(state.gamma, lift), relative = spoolDeg - pinionDeg;
      const captures = contact && fit(relative) && lift < CLEAR_LIFT_MM - .1 &&
        yokeLift(state.q) + YOKE_CLIP_FREE_RISE_MM < lift + 1e-7;
      return { state, lift, contact, captures, spoolDeg, pinionDeg };
    }

    const before = candidate(0), after = candidate(1);
    const direction = Math.sign(base1 - base0);
    const entry = -direction * SLOT_CAPTURE_HALF_ANGLE_DEG, entryLift = guardProfile(entry);
    const entryBase = entry + HELIX_DEG_PER_MM * entryLift;
    const quotient = (base0 - entryBase) / SLOT_PERIOD_DEG;
    const detent = direction > 0 ? Math.ceil(quotient) : Math.floor(quotient);
    const crossing = direction ? (entryBase + SLOT_PERIOD_DEG * detent - base0) / (base1 - base0) : Infinity;
    let entryPick;
    if (crossing >= 0 && crossing <= 1) {
      const state = mixPose(a, b, crossing), spoolDeg = spindle + manual * crossing;
      const beforeRelative = base0 - HELIX_DEG_PER_MM * oldLift, entryRelative = entry + SLOT_PERIOD_DEG * detent;
      const approaching = direction * (entryRelative - beforeRelative) >= -EPS;
      if (approaching && oldLift >= entryLift - EPS && yokeLift(state.q) + YOKE_CLIP_FREE_RISE_MM <= entryLift + EPS) {
        entryPick = { state, lift: entryLift, spoolDeg, pinionDeg: angle(state.gamma, entryLift) };
      }
    }
    if (!before.captures && !after.captures && !entryPick) {
      current.spoolDeg = after.spoolDeg;
      current.pinionDeg = after.pinionDeg;
      current.pinionLift = after.lift;
      current.inserting = current.awaitAxialThrust = false;
      current.waiting = after.lift > nominalPinionLift(b.q) + EPS;
      current.dogContact = after.contact ? (after.lift >= CLEAR_LIFT_MM - .002 ? 'flat' : 'lead-in') : 'free';
      current.leadInSpring = false;
      if (!holdSpoolOnNose && Math.abs(manual) <= EPS && after.contact) moveSpoolDownNose(b, seat, !plateInput && b.gamma > a.gamma + EPS);
      return;
    }

    let lo = 0, hi = before.captures ? 0 : after.captures ? 1 : crossing;
    for (let i = 0; i < 26 && hi - lo > 1e-8; i++) {
      if (entryPick && !after.captures) break;
      const t = (lo + hi) / 2;
      if (candidate(t).captures) hi = t;
      else lo = t;
    }
    const picked = entryPick && crossing <= hi ? entryPick : candidate(hi);
    if (picked === entryPick) hi = crossing;
    current.spoolDeg = picked.spoolDeg;
    current.pinionDeg = picked.pinionDeg;
    current.pinionLift = picked.lift;
    current.engaged = true;
    current.pickup = { gamma: picked.state.gamma, spoolDeg: picked.spoolDeg, pinionDeg: picked.pinionDeg, lift: picked.lift };
    moveLatched(picked.state, b, seat * (1 - hi));
  }

  function segment(a, b, manual, seat) {
    const below = a.q > Q_CLEAR || b.q > Q_CLEAR;
    if (!below) {
      current.spoolDeg += manual;
      current.pinionLift = nominalPinionLift(b.q);
      current.pinionDeg = angle(b.gamma, current.pinionLift);
      current.engaged = current.inserting = current.waiting = current.awaitAxialThrust = false;
      current.leadInSpring = false;
      current.dogContact = 'free';
      return;
    }
    if (current.engaged) {
      moveLatched(a, b, seat);
      return;
    }

    const travel = Math.abs(manual + GEAR_RATIO * (b.gamma - a.gamma));
    const count = Math.max(1, Math.ceil(travel / .25), Math.ceil(Math.abs(b.q - a.q) / .2));
    for (let i = 0; i < count; i++) {
      const from = mixPose(a, b, i / count), to = mixPose(a, b, (i + 1) / count);
      if (current.engaged) moveLatched(from, to, seat / count);
      else moveFree(from, to, manual / count, seat / count);
    }
  }

  for (const { from, to, extent: run } of segments) {
    const weight = extent ? run / extent : 1 / segments.length;
    const share = spoolDeltaDeg * weight, seat = seatTravel * weight;
    if ((from.q < Q_CLEAR && to.q > Q_CLEAR) || (from.q > Q_CLEAR && to.q < Q_CLEAR)) {
      const t = (Q_CLEAR - from.q) / (to.q - from.q), split = { ...mixPose(from, to, t), q: Q_CLEAR };
      segment(from, split, share * t, seat * t);
      segment(split, to, share * (1 - t), seat * (1 - t));
    } else segment(from, to, share, seat);
  }
  current.yokeLift = Math.max(yokeLift(toClutch.q), current.pinionLift - YOKE_CLIP_FREE_RISE_MM);
  return current;
}

function advanceCoupledCrank(contact, clutch, drive, targetGamma, seatTravelMm, options) {
  const total = targetGamma - clutch.gamma;
  if (total <= EPS) {
    const next = contact.advanceCrank(clutch, targetGamma);
    return { clutch: next, drive: advanceCoupling(drive, clutch, next, 0, seatTravelMm, options) };
  }
  const steps = [], leadInSteps = [];
  let pickup = null, passiveSpoolDeltaDeg = 0;
  while (targetGamma - clutch.gamma > EPS) {
    const target = clutch.event === 'low-stop' ? targetGamma : Math.min(targetGamma, clutch.gamma + .2);
    const next = contact.advanceCrank(clutch, target, { yokeFloor: gamma => yokeFloorAt(drive, gamma) });
    const seat = seatTravelMm === undefined ? undefined : seatTravelMm * Math.max(0, next.gamma - clutch.gamma) / total;
    drive = advanceCoupling(drive, clutch, next, 0, seat, options);
    pickup = drive.pickup ?? pickup;
    passiveSpoolDeltaDeg += drive.passiveSpoolDeltaDeg;
    leadInSteps.push(...drive.leadInSteps);
    steps.push(...next.steps);
    clutch = next;
    if (clutch.blocked) break;
  }
  return { clutch: { ...clutch, steps }, drive: { ...drive, pickup, passiveSpoolDeltaDeg, leadInSteps } };
}

return { initialCoupling, advanceCoupling, advanceCoupledCrank: typeof advanceCoupledCrank === "function" ? advanceCoupledCrank : undefined, CLEAR_LIFT_MM: typeof CLEAR_LIFT_MM === "number" ? CLEAR_LIFT_MM : undefined, HELIX_DEG_PER_MM: typeof HELIX_DEG_PER_MM === "number" ? HELIX_DEG_PER_MM : undefined };
})();

const opControls = (() => {

function createOperationTransport(sim, scheduler = globalThis) {
  const subscribers = new Set();
  let action = null, frame = 0, last = null, error = '';
  let maxSpoolAdvanceMs = 0;
  const controls284 = sim.controlsVersion === 284;
  const emit = () => { for (const notify of subscribers) notify(); };
  const rates = { plate: sim.plateRate || 60, crank: 90, spool: 150 };
  const recoveryStep = 0.25;
  const settling = drive => drive.inserting || drive.leadInSpring;
  function pause(notify = true) {
    scheduler.cancelAnimationFrame(frame);
    frame = 0;
    action = null;
    last = null;
    if (notify) emit();
  }
  function tick(now) {
    frame = 0;
    const current = action;
    if (!current) return;
    const dt = last === null ? 1 / 60 : Math.max(0, (now - last) / 1000);
    last = now;
    try {
      const before = sim.state;
      if (current.kind === 'plate') {
        const q = before.clutch.q;
        if (sim.passivePlate) {
          current.progress += rates.plate * dt;
          const target = current.progress >= current.distance ? current.target : current.start + current.direction * current.progress;
          sim.advance('plate', target, dt);
          const reached = Math.abs(sim.state.clutch.q - current.target) <= sim.plateStopTolerance;
          if (sim.state.clutch.blocked || reached) {
            action = reached && current.target === sim.pressQ ?
              { kind: 'release', control: current.control } : null;
          }
        } else {
          const amount = Math.min(Math.abs(current.target - q), rates.plate * dt);
          sim.advance('plate', q + Math.sign(current.target - q) * amount, dt);
          const next = sim.state.clutch;
          if (Math.abs(next.q - current.target) < 1e-7 || next.blocked ||
              (amount > 0 && Math.abs(next.q - q) < 1e-8)) action = null;
        }
      } else if (current.kind === 'release') {
        sim.advance('release', 0, dt);
        action = null;
      } else if (current.kind === 'recover') {
        current.pending += rates.crank * dt;
        while (current.pending + 1e-8 >= recoveryStep && !sim.clutchIsReset()) {
          const gamma = sim.state.clutch.gamma;
          sim.advance('crank', recoveryStep, recoveryStep / rates.crank);
          current.pending -= recoveryStep;
          if (sim.state.clutch.blocked || sim.state.clutch.gamma <= gamma + 1e-8) {
            action = null;
            break;
          }
          if (sim.state.clutch.gamma - current.startGamma >= 360 && !sim.clutchIsReset()) {
            error = '正向摇臂一圈后，离合仍待接合';
            action = null;
            break;
          }
        }
        if (sim.clutchIsReset()) action = null;
      } else if (current.kind === 'cup') {
        if (!current.winding && !sim.canReverseSpool()) {
          action = null;
        } else {
          const amount = Math.min(current.left, rates.spool * dt);
          const begin = performance.now();
          if (current.winding) sim.windSpool(amount, dt);
          else sim.advance('spool', amount, dt);
          maxSpoolAdvanceMs = Math.max(maxSpoolAdvanceMs, performance.now() - begin);
          const next = sim.state;
          const cupDelta = next.drive.spoolDeg - before.drive.spoolDeg;
          const passive = before.drive.engaged ? 0 : next.drive.passiveSpoolDeltaDeg || 0;
          const moved = (current.winding ? -1 : 1) * (cupDelta - passive);
          current.left -= before.drive.engaged ? moved : Math.max(0, moved);
          const progressed = Math.abs(cupDelta) > 1e-8 || next.clutch.gamma > before.clutch.gamma + 1e-8 ||
            next.drive.engaged !== before.drive.engaged;
          if (current.left < 1e-7 || (before.drive.engaged && next.clutch.blocked) || (amount > 0 && !progressed) ||
              (!current.winding && !sim.canReverseSpool())) action = null;
        }
      } else if (current.kind === 'crank' || current.kind === 'spool') {
        if (current.control === 'seek') current.left = Math.max(0, current.target - before.clutch.gamma);
        const amount = Math.min(current.left, rates[current.kind] * dt);
        const begin = current.kind === 'spool' ? performance.now() : 0;
        sim.advance(current.kind, current.direction * amount, dt);
        if (begin) maxSpoolAdvanceMs = Math.max(maxSpoolAdvanceMs, performance.now() - begin);
        const moved = current.kind === 'crank' ? sim.state.clutch.gamma - before.clutch.gamma :
          Math.max(0, current.direction * (sim.state.drive.spoolDeg - before.drive.spoolDeg - (sim.state.drive.passiveSpoolDeltaDeg || 0)));
        current.left -= moved;
        if (current.left < 1e-7 || (amount > 0 && moved < 1e-8) ||
            (current.kind === 'spool' && sim.state.drive.engaged)) action = null;
      } else {
        sim.advance('settle', 0, dt);
        const drive = sim.state.drive;
        if (!settling(drive) || (dt > 0 && Math.abs(drive.pinionLift - before.drive.pinionLift) < 1e-7 &&
            Math.abs(drive.spoolDeg - before.drive.spoolDeg) < 1e-7)) action = null;
      }
      if (!action && current.kind !== 'settle' && settling(sim.state.drive)) {
        action = { kind: 'settle', control: current.control };
      }
      emit();
    } catch (failure) {
      pause(false);
      error = failure.message;
      emit();
    }
    if (action && !frame) frame = scheduler.requestAnimationFrame(tick);
  }
  function start(next) {
    pause(false);
    error = '';
    action = next;
    emit();
    frame = scheduler.requestAnimationFrame(tick);
  }
  function turnSpool(winding, degrees) {
    if (!controls284 || !Number.isFinite(degrees) || degrees <= 0 || (!winding && !sim.canReverseSpool())) return false;
    start({ kind: 'cup', control: winding ? 'spool-forward' : 'spool-reverse', winding, left: degrees });
    return true;
  }
  return {
    sim,
    get action() { return action?.kind || ''; },
    get activeControl() { return action?.control || ''; },
    get error() { return error; },
    get maxSpoolAdvanceMs() { return maxSpoolAdvanceMs; },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    plate(down) {
      const target = down ? sim.pressQ : 0, startQ = sim.state.clutch.q;
      start({ kind: 'plate', target, start: startQ, distance: Math.abs(target - startQ),
        direction: Math.sign(target - startQ), progress: 0, control: down ? 'press' : 'lift' });
    },
    crank(degrees = Infinity) {
      if (degrees > 0) start({ kind: 'crank', left: degrees, direction: 1, control: degrees === Infinity ? 'wind' : 'crank' });
    },
    recoverClutch() {
      if (!controls284 || sim.clutchIsReset()) return false;
      start({ kind: 'recover', control: 'recover', pending: 0, startGamma: sim.state.clutch.gamma });
      return true;
    },
    seekCrankPhase(phase) {
      if (!controls284 || !Number.isFinite(phase) || phase < 0 || phase > 360) return false;
      const gamma = sim.state.clutch.gamma;
      let target = Math.floor((gamma + 1e-8) / 360) * 360 + phase;
      if (target < gamma - 1e-8) target += 360;
      if (target > gamma + 1e-8) {
        if (action?.control === 'seek') action.target = target;
        else start({ kind: 'crank', target, direction: 1, control: 'seek' });
      } else if (action) {
        pause();
      }
      return true;
    },
    spool(degrees) {
      if (controls284) return turnSpool(degrees > 0, Math.abs(degrees));
      if (!sim.state.drive.engaged) start({ kind: 'spool', left: Math.abs(degrees), direction: Math.sign(degrees) });
    },
    turnSpool,
    reset() { pause(false); error = ''; sim.reset(); emit(); },
    pause,
  };
}

function mountOperationControls(root, transport, summary) {
  const controls284 = transport.sim.controlsVersion === 284;
  const crankStep = transport.sim.passivePlate ? '0.1' : '1';
  const crankButtons = controls284 ?
    '<button data-operation="recover" type="button">摇臂复位离合</button>' :
    '<button data-operation="crank" type="button">逆时针一步</button>';
  const crankSlider = controls284 ?
    '<label data-operation-slider>摇臂角度 0–360° <input data-operation-size="crank" type="range" min="0" max="360" step="0.1" value="0"><output data-operation-angle="crank">0.0°</output></label><small>受止逆限制，回拖按正向跨圈到达。</small>' :
    '<label data-operation-slider>摇臂步长 <input data-operation-size="crank" type="range" min="' + crankStep +
    '" max="180" step="' + crankStep + '" value="15"><output data-operation-angle="crank">15°</output></label>';
  root.innerHTML = [
    '<section data-operation-panel="' + (controls284 ? '284' : '278') + '" aria-label="真实操作联动" style="display:grid;gap:8px">',
    '<div><strong>按板</strong><div data-operation-actions><button data-operation="press" type="button">按板按下</button><button data-operation="lift" type="button">按板抬起</button></div></div>',
    '<div><strong>摇臂</strong><small> · 外侧看逆时针</small><div data-operation-actions>' + crankButtons +
      '<button data-operation="wind" type="button">连续摇臂</button></div>' + crankSlider + '</div>',
    '<div><strong>线杯</strong>' + (controls284 ? '<small> · 正转为收线方向</small>' : '') +
      '<div data-operation-actions><button data-operation="spool-forward" type="button">线杯正转</button><button data-operation="spool-reverse" type="button">线杯反转</button></div>',
    '<label data-operation-slider>线杯步长 <input data-operation-size="spool" type="range" min="1" max="720" step="1" value="15"><output data-operation-angle="spool">15°</output></label></div>',
    '<div data-operation-actions><button data-operation="pause" type="button">暂停</button><button data-operation="reset" type="button">恢复初始状态</button></div>',
    '<output data-operation-state aria-live="polite"></output><output data-operation-detail></output>',
    '</section>',
    controls284 ? '<style>' +
      '[data-operation-panel="284"] button{background:#eef7fa;color:#15495a;border-color:#9db5bf}' +
      '[data-operation-panel="284"] button:not(:disabled):is(:active,[data-active="true"]){background:#145568;color:#fff;border-color:#145568}' +
      '[data-operation-panel="284"] button:disabled{background:#e5e7eb;color:#6b7280;border-color:#cbd2d8;opacity:1;cursor:default}' +
      '</style>' : '',
  ].join('');
  const panel = root.firstElementChild;
  const document = root.ownerDocument, window = document.defaultView;
  let dragPointer = null;
  const button = action => panel.querySelector('[data-operation="' + action + '"]');
  const input = kind => panel.querySelector('[data-operation-size="' + kind + '"]');
  const value = kind => Number(input(kind).value);
  for (const group of panel.querySelectorAll('[data-operation-actions]')) {
    group.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:3px';
  }
  for (const label of panel.querySelectorAll('[data-operation-slider]')) {
    label.style.cssText = 'display:grid;grid-template-columns:auto minmax(55px,1fr) ' +
      (controls284 ? '4em' : '3em') + ';align-items:center;gap:6px';
  }
  for (const action of panel.querySelectorAll('button')) {
    action.style.cssText = 'padding:3px 8px;border-width:1px;border-style:solid;border-radius:4px' +
      (controls284 ? '' : ';border-color:currentColor');
  }
  const actions = {
    press: () => transport.plate(true),
    lift: () => transport.plate(false),
    ...(controls284 ? { recover: () => transport.recoverClutch() } : { crank: () => transport.crank(value('crank')) }),
    wind: () => transport.crank(),
    'spool-forward': () => controls284 ? transport.turnSpool(true, value('spool')) : transport.spool(value('spool')),
    'spool-reverse': () => controls284 ? transport.turnSpool(false, value('spool')) : transport.spool(-value('spool')),
    pause: () => transport.pause(),
    reset: () => transport.reset(),
  };
  for (const [id, run] of Object.entries(actions)) button(id).onclick = run;
  for (const kind of controls284 ? ['spool'] : ['crank', 'spool']) input(kind).oninput = () => {
    panel.querySelector('[data-operation-angle="' + kind + '"]').textContent = value(kind) + '°';
  };
  const stateLine = panel.querySelector('[data-operation-state]'), detail = panel.querySelector('[data-operation-detail]');
  const refresh = () => {
    const state = summary(transport.sim), { clutch, drive } = transport.sim.state;
    button('pause').disabled = !transport.action;
    if (controls284) {
      button('recover').disabled = transport.sim.clutchIsReset();
      button('spool-reverse').disabled = !transport.sim.canReverseSpool();
      const phase = state.phase > 360 - 1e-8 ? 0 : state.phase;
      if (dragPointer === null) input('crank').value = String(phase);
      panel.querySelector('[data-operation-angle="crank"]').textContent = phase.toFixed(1) + '°';
      const selected = transport.activeControl;
      const plateMoving = selected === 'press' || selected === 'lift';
      for (const control of panel.querySelectorAll('button')) {
        const name = control.dataset.operation;
        const plateHeld = !plateMoving && ((name === 'press' && clutch.highPlatform) ||
          (name === 'lift' && clutch.event === 'low-stop'));
        const active = String(name === selected || plateHeld);
        if (control.dataset.active !== active) control.dataset.active = active;
      }
    } else {
      button('spool-forward').disabled = button('spool-reverse').disabled = drive.engaged || drive.inserting;
    }
    const action = transport.sim.state.action;
    const held = state.blocked && !clutch.highPlatform && (action === 'plate' ? '按板停在当前接触位置' :
      action === 'crank' ? '摇臂停在当前接触位置' : '');
    let plate = '';
    if (transport.action === 'release') plate = '按板松手中';
    else if (clutch.highPlatform && transport.action !== 'plate') {
      plate = clutch.contact ? '放线位 · 杆尖压住齿盘，摇臂可复位' : '放线位 · 松手后保持高位';
    }
    const condition = transport.error || [held || plate, state.coupling].filter(Boolean).join(' · ');
    if (stateLine.textContent !== condition) stateLine.textContent = condition;
    detail.textContent = '齿盘 ' + state.phase.toFixed(2) + '°（累计 ' + state.gamma.toFixed(2) + '°） · 按板 ' +
      state.cam.toFixed(2) + '° · 小齿升程 ' + state.lift.toFixed(3) + ' mm · 托架升程 ' + state.yoke.toFixed(3) +
      ' mm · 线杯 ' + state.spool.toFixed(2) +
      '°（累计 ' + state.spoolTotal.toFixed(2) + '°） · 线规翻转 ' + state.flip.toFixed(2) + '°';
    panel.dataset.gamma = String(clutch.gamma);
    panel.dataset.cam = String(clutch.q);
    panel.dataset.spool = String(drive.spoolDeg);
    panel.dataset.worm = String(state.worm);
    panel.dataset.flip = String(state.flip);
    panel.dataset.yoke = String(state.yoke);
    panel.dataset.pinion = String(state.lift);
    panel.dataset.engaged = String(Boolean(drive.engaged));
    panel.dataset.waiting = String(Boolean(drive.waiting));
    panel.dataset.dogContact = drive.dogContact || '';
    panel.dataset.awaitAxialThrust = String(Boolean(drive.awaitAxialThrust));
    panel.dataset.highPlatform = String(Boolean(clutch.highPlatform));
    panel.dataset.action = transport.action;
  };
  const finishDrag = event => {
    if (event.pointerId !== dragPointer) return;
    dragPointer = null;
    if (event.type === 'pointercancel') transport.pause();
    else refresh();
  };
  if (controls284) {
    const crankInput = input('crank');
    crankInput.onpointerdown = event => {
      dragPointer = event.pointerId;
      transport.pause();
    };
    crankInput.oninput = () => {
      transport.seekCrankPhase(Number(crankInput.value));
      refresh();
    };
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
  }
  const unsubscribe = transport.subscribe(refresh);
  const pauseWhenHidden = () => {
    if (!document.hidden) return;
    const dragging = dragPointer !== null;
    dragPointer = null;
    if (transport.action) transport.pause();
    else if (dragging) refresh();
  };
  document.addEventListener('visibilitychange', pauseWhenHidden);
  refresh();
  return () => {
    if (controls284) {
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
    }
    document.removeEventListener('visibilitychange', pauseWhenHidden);
    unsubscribe();
    root.replaceChildren();
  };
}

return { createOperationTransport, mountOperationControls };
})();

const opSpringWarp = (() => {

const springSubtract = (a, b) => a.map((v, i) => v - b[i]);
const springScale = (a, k) => a.map(v => v * k);
const springAdd = (a, b) => a.map((v, i) => v + b[i]);
const springDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const springCross = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const springUnit = a => springScale(a, 1 / Math.hypot(...a));

function springSegments(points) {
  return points.slice(0, -1).map((start, i) => {
    const delta = springSubtract(points[i + 1], start);
    return { start, delta, lengthSquared: springDot(delta, delta), tangent: springUnit(delta) };
  });
}

function bindSpringVertex(point, segments) {
  let best = null, closest = Infinity;
  for (const [index, segment] of segments.entries()) {
    const offset = springSubtract(point, segment.start);
    const t = Math.min(1, Math.max(0, springDot(offset, segment.delta) / segment.lengthSquared));
    const radial = springSubtract(offset, springScale(segment.delta, t));
    const distance = springDot(radial, radial);
    if (distance < closest) {
      closest = distance;
      best = { index, t, radial, tangent: segment.tangent, radius: Math.sqrt(distance) };
    }
  }
  return best;
}

function deformSpringVertex(binding, normal, targetSegments) {
  const segment = targetSegments[binding.index];
  const across = springCross(binding.tangent, segment.tangent);
  const denominator = Math.max(1e-8, 1 + springDot(binding.tangent, segment.tangent));
  const turn = vector => {
    const cross = springCross(across, vector);
    return springAdd(vector, springAdd(cross, springScale(springCross(across, cross), 1 / denominator)));
  };
  const center = springAdd(segment.start, springScale(segment.delta, binding.t));
  return { point: springAdd(center, turn(binding.radial)), normal: normal && turn(normal) };
}

return { bindSpringVertex, deformSpringVertex, springSegments };
})();

const opSpringMesh = (() => {
const { bindSpringVertex, deformSpringVertex, springSegments } = opSpringWarp;
function createOperationSpring(mesh, localToCad, baseline, wireRadiusMm) {
  const geometry = mesh.geometry.clone();
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
  const originalPosition = position.array.slice(), originalNormal = normal?.array.slice();
  const inverse = localToCad.clone().invert(), point = mesh.position.clone();
  const segments = springSegments(baseline);
  const restZ = wireRadiusMm && [Infinity, -Infinity];
  const bindings = Array.from({ length: position.count }, (_, i) => {
    const world = point.fromBufferAttribute(position, i).applyMatrix4(localToCad).toArray();
    if (restZ) {
      restZ[0] = Math.min(restZ[0], world[2]);
      restZ[1] = Math.max(restZ[1], world[2]);
    }
    return bindSpringVertex(world, segments);
  });
  const bounds = wireRadiusMm ? [0, wireRadiusMm + Math.max(0.035, wireRadiusMm * 0.3)] : [0.12, 0.24];
  if (bindings.some(binding => !binding || !(binding.radius >= bounds[0] && binding.radius <= bounds[1]))) {
    geometry.dispose();
    throw Error('弹簧显示网格与装配基准不一致');
  }
  const normals = normal && Array.from({ length: normal.count }, (_, i) =>
    point.fromBufferAttribute(normal, i).transformDirection(localToCad).toArray());
  const original = mesh.geometry;
  mesh.geometry = geometry;
  let last = null, cadZ = restZ;
  function refresh() {
    position.needsUpdate = true;
    if (normal) normal.needsUpdate = true;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  function restore() {
    if (last === null) return;
    position.array.set(originalPosition);
    if (normal) normal.array.set(originalNormal);
    last = null;
    cadZ = restZ;
    refresh();
  }
  return {
    geometry,
    vertices: position.count,
    get cadZ() { return cadZ; },
    restore,
    deform({ key, points, base }) {
      if (points === base) { restore(); return; }
      if (key === last) return;
      const target = springSegments(points);
      const z = restZ && [Infinity, -Infinity];
      for (let i = 0; i < position.count; i++) {
        const result = deformSpringVertex(bindings[i], normals?.[i], target);
        if (z) {
          z[0] = Math.min(z[0], result.point[2]);
          z[1] = Math.max(z[1], result.point[2]);
        }
        point.fromArray(result.point).applyMatrix4(inverse);
        position.setXYZ(i, point.x, point.y, point.z);
        if (normal) {
          point.fromArray(result.normal).transformDirection(inverse);
          normal.setXYZ(i, point.x, point.y, point.z);
        }
      }
      last = key;
      cadZ = z;
      refresh();
    },
    close() {
      mesh.geometry = original;
      geometry.dispose();
    },
  };
}

return { createOperationSpring };
})();

let operation278 = null;

function isOperation278() {
  return mechanisms()[mechanismIndex]?.id === 'operation278';
}

function operationMesh278(data, sim) {
  // The pinned model-viewer exposes a scene graph but no public per-node pose setters.
  const sceneKey = Object.getOwnPropertySymbols(viewer).find(key => key.description === 'scene');
  const scene = viewer[sceneKey], model = scene?._models?.[0];
  if (!model || typeof scene.queueRender !== 'function') throw Error('当前三维查看器缺少装配联动接口');
  model.updateMatrixWorld(true);
  const rootInverse = model.matrixWorld.clone().invert();
  const transforms = new Map(data.targets.map(id => {
    const node = model.getObjectByName('operation278-' + id);
    if (!node) throw Error('联动零件缺失 ' + id);
    node.matrixAutoUpdate = false;
    return [id, node];
  }));
  const { cadVectorToGlb, cadPointToGlb } = opCoordinates;
  const matrix = model.matrix.clone(), unpivot = matrix.clone(), pivot = matrix.clone(), axis = model.position.clone();
  const glbToCad = matrix.clone().set(1000, 0, 0, 0, 0, 0, -1000, 0, 0, 1000, 0, 0, 0, 0, 0, 1);
  const springs = new Map();
  const { flex, compressionSprings } = sim.pose();
  try {
    for (const spring of [flex, ...compressionSprings]) {
      const parent = model.getObjectByName(spring.partId), meshes = [];
      if (!parent) throw Error('弹簧节点缺失 ' + spring.partId);
      springs.set(spring.partId, meshes);
      parent.traverse(node => {
        if (!node.isMesh) return;
        const localToCad = glbToCad.clone().multiply(rootInverse).multiply(node.matrixWorld);
        meshes.push(opSpringMesh.createOperationSpring(node, localToCad, spring.base, spring.wireRadiusMm));
      });
      if (!meshes.length) throw Error('弹簧显示网格缺失 ' + spring.partId);
    }
  } catch (error) {
    for (const meshes of springs.values()) meshes.forEach(mesh => mesh.close());
    throw error;
  }
  const redraw = () => { scene.queueShadowRender?.(); scene.queueRender(); };
  function resetMatrices() {
    for (const node of transforms.values()) {
      node.matrix.identity();
      node.matrixWorldNeedsUpdate = true;
    }
  }
  return {
    draw(pose) {
      resetMatrices();
      for (const motion of pose.operations) {
        if (motion.kind === 'rotate') {
          if (!motion.degrees) continue;
          const center = cadPointToGlb(motion.point);
          axis.fromArray(cadVectorToGlb(motion.axis)).normalize();
          matrix.makeRotationAxis(axis, motion.degrees * Math.PI / 180)
            .multiply(unpivot.makeTranslation(...center.map(v => -v)))
            .premultiply(pivot.makeTranslation(...center));
        } else {
          matrix.makeTranslation(...cadPointToGlb(motion.vector));
        }
        for (const id of motion.partIds) transforms.get(id).matrix.premultiply(matrix);
      }
      for (const spring of [pose.flex, ...pose.compressionSprings]) {
        springs.get(spring.partId).forEach(mesh => mesh.deform(spring));
      }
      redraw();
    },
    suspend() { resetMatrices(); for (const meshes of springs.values()) meshes.forEach(mesh => mesh.restore()); redraw(); },
    close() { resetMatrices(); for (const meshes of springs.values()) meshes.forEach(mesh => mesh.close()); },
  };
}

function setupOperation278(data) {
  clearOperation278();
  if (!data) return;
  const sim = opState.createOperationState(data, opContact.makeClutchContact(data.contact), opCoupling, opTorsion284);
  const transport = opControls.createOperationTransport(sim);
  const mesh = operationMesh278(data, sim);
  const update = transport.subscribe(() => {
    if (isOperation278() && partsUI.isAssembly()) mesh.draw(sim.pose());
  });
  const unmount = opControls.mountOperationControls($('#operation278'), transport, opState.operationSummary);
  operation278 = { transport, mesh, update, unmount };
}

function updateOperation278() {
  const panel = $('#operation278');
  panel.hidden = !operation278 || !partsUI.isAssembly() || !isOperation278();
  if (!panel.hidden) operation278.mesh.draw(operation278.transport.sim.pose());
}

function pauseOperation278() { operation278?.transport.pause(); }

function clearOperation278() {
  if (!operation278) return;
  operation278.transport.pause(false);
  operation278.update();
  operation278.unmount();
  operation278.mesh.close();
  operation278 = null;
  $('#operation278').hidden = true;
}

const $=s=>document.querySelector(s),status=$('#status'),viewer=$('#viewer'),revisionViewer=$('#revision-viewer');
let key=null,catalog=null,base=null,epoch=0,selection=0,active=-1,controller=null;
const cache=new Map(),plainCache=new Map(),pendingModels=new Map(),encoder=new TextEncoder();
let mainIndex=-1,revisionIndex=-1,revisionRequest=0,revisionLoading=-1;
let motionFrame=0,motionConfig=null,loadingIndex=-1,motionSequence=0,mechanismSequence=0,mechanismIndex=0;
const pageIdentity=new URL('.',location.href).href,lockFlag='cad-preview-locked:'+pageIdentity;
const partsUI=createPartsController({viewer,partViewer:$('#part-viewer'),revisionViewer,stopMotion,tell,onModeChange:mode=>{
  if(!catalog)return;
  if(mode!=='assembly')pauseOperation278();
  if(mode==='revision')selectRevision(Number($('#revision-select').value));
  else if(mode==='assembly'&&document.documentElement.dataset.loaded!==String(mainIndex))selectModel(mainIndex);
  updateMotionUI();
}});
const travelSeconds=()=>Number($('#motion-duration').value)||1;
function clampMotionTime(time, duration) {
  return Math.min(duration, Math.max(0, Number(time) || 0));
}

function motionModulo(value, period) {
  const remainder = value % period;
  return remainder < 0 ? remainder + period : remainder || 0;
}

function advanceMotion(phase, delta, duration, mode, direction = 1) {
  if (!(duration > 0)) return { phase: 0, time: 0, playing: false };
  const next = phase + delta * direction;
  if (mode === 'rotation') {
    const time = motionModulo(next, duration);
    return { phase: time, time, playing: true };
  }
  if (mode === 'pingpong') {
    const phase = motionModulo(next, 2 * duration);
    const time = Math.min(phase, 2 * duration - phase);
    return { phase, time, playing: true };
  }
  const time = clampMotionTime(next, duration);
  return { phase: time, time, playing: direction > 0 ? next < duration : next > 0 };
}

function motionStrokeTime(time, duration, strokeDuration = duration) {
  const stroke = Math.min(strokeDuration, duration);
  if (!(stroke > 0)) return 0;
  const clipped = clampMotionTime(time, duration);
  return clipped <= stroke ? clipped : motionModulo(clipped, stroke);
}

function formatMotionReadout(readout, time) {
  const { rows, takeUp, activeLabel } = readout;
  let low = 0, high = rows.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (rows[middle][0] <= time) low = middle;
    else high = middle;
  }
  const from = rows[low], to = rows[high];
  const t = Math.min(1, Math.max(0, (time - from[0]) / (to[0] - from[0])));
  const [cam, disc, pinion, flip] = from.slice(1).map((value, i) => value + (to[i + 1] - value) * t);
  const label = time < takeUp ? '低位预定位' : activeLabel;
  return label + ' · 齿盘 ' + disc.toFixed(2) + '° · 离合座 ' + cam.toFixed(2) +
    '° · 小齿升程 ' + pinion.toFixed(3) + ' mm · 线规 ' + flip.toFixed(2) + '°';
}

let motionRun = null;
let motionPhase = null;

function motionPlayback() {
  return mechanisms()[mechanismIndex]?.playback || { mode: 'once' };
}

function motionStrokeDuration() {
  return Math.min(viewer.duration, motionPlayback().strokeDuration || viewer.duration);
}

function updateTransportControls() {
  const { mode } = motionPlayback();
  const rotation = mode === 'rotation';
  $('#motion-play').hidden = rotation;
  $('#motion-forward').hidden = $('#motion-reverse').hidden = $('#motion-pause').hidden = !rotation;
  $('#motion-play').textContent = motionRun ? '暂停' : mode === 'pingpong' ? '往返循环' : '单程播放';
  $('#motion-pause').disabled = !motionRun;
  $('#motion-forward').setAttribute('aria-pressed', String(motionRun?.mode === 'rotation' && motionRun.direction > 0));
  $('#motion-reverse').setAttribute('aria-pressed', String(motionRun?.mode === 'rotation' && motionRun.direction < 0));
  $('label[for="motion-duration"]').textContent = rotation ? '单圈时间' : '单程时间';
}

function stopMotion() {
  cancelAnimationFrame(motionFrame);
  motionFrame = 0;
  motionRun = null;
  viewer.pause?.();
  updateTransportControls();
}

function seekMotion(time) {
  viewer.timeScale = 1;
  viewer.play({ repetitions: 1, pingpong: false });
  viewer.currentTime = clampMotionTime(time, viewer.duration);
  viewer.pause();
}

function dragMotion(fraction) {
  stopMotion();
  motionPhase = null;
  seekMotion(motionStrokeDuration() * fraction);
  showMotionProgress();
}

function playMotion(mode, direction = 1) {
  const duration = viewer.duration;
  if (!duration) return;
  let phase = mode === 'pingpong' && motionPhase !== null ? motionPhase : viewer.currentTime;
  stopMotion();
  if (mode === 'once' && phase >= duration) {
    phase = 0;
    seekMotion(0);
    showMotionProgress();
  }
  const run = { mode, direction, epoch, mechanismIndex };
  motionRun = run;
  updateTransportControls();
  let last = performance.now();
  const frame = now => {
    if (motionRun !== run || run.epoch !== epoch || run.mechanismIndex !== mechanismIndex || !partsUI.isAssembly()) return;
    const delta = (now - last) / 1000 * motionStrokeDuration() / travelSeconds();
    last = now;
    const next = advanceMotion(phase, delta, duration, mode, direction);
    phase = next.phase;
    motionPhase = mode === 'pingpong' ? phase : null;
    seekMotion(next.time);
    showMotionProgress();
    if (next.playing) motionFrame = requestAnimationFrame(frame);
    else stopMotion();
  };
  motionFrame = requestAnimationFrame(frame);
}

function moveTo(fraction) {
  if (!viewer.duration) return;
  const stroke = motionStrokeDuration();
  if (viewer.currentTime > stroke) {
    dragMotion(fraction);
    return;
  }
  stopMotion();
  motionPhase = null;
  const start = viewer.currentTime, target = stroke * fraction;
  const distance = Math.abs(target - start);
  if (distance === 0) return;
  const began = performance.now(), durationMs = travelSeconds() * 1000 * distance / stroke;
  const frame = now => {
    const t = Math.min(1, (now - began) / durationMs);
    seekMotion(t < 1 ? start + (target - start) * t : target);
    showMotionProgress();
    motionFrame = t < 1 ? requestAnimationFrame(frame) : 0;
  };
  motionFrame = requestAnimationFrame(frame);
}

function showMotionProgress(){
  updateSequence270();
  const stroke = motionStrokeDuration();
  const fraction = stroke > 0 ? motionStrokeTime(viewer.currentTime, viewer.duration, stroke) / stroke : 0;
  $('#motion-progress').value=String(Math.round(fraction*1000));
  const motion=motionConfig;
  const readout = mechanisms()[mechanismIndex]?.readout;
  if(readout) {
    $('#motion-status').textContent = formatMotionReadout(readout, viewer.currentTime);
  }else if(motion?.samples){
    const angle=fraction*motion.angleMaxDeg,rows=motion.samples;let i=0;while(i+1<rows.length-1&&angle>rows[i+1].angleDeg)i++;
    const a=rows[i],b=rows[i+1],f=Math.max(0,Math.min(1,(angle-a.angleDeg)/(b.angleDeg-a.angleDeg)));
    const lift=a.pinionLiftMm+(b.pinionLiftMm-a.pinionLiftMm)*f;
    $('#motion-status').textContent=(motion.driveLabel||'驱动角度')+' '+angle.toFixed(1)+'° · '+(motion.drivenLabel||'联动位移')+' '+lift.toFixed(3)+' mm';
  }else $('#motion-status').textContent='进度 '+(fraction*100).toFixed(0)+'%';
}
async function selectMotion(index){
  const run=epoch,request=selection,motionRequest=++motionSequence,entry=catalog.models[active],names=viewer.availableAnimations;
  stopMotion();motionPhase=null;const name=names[index];motionConfig=entry.motions?.find(m=>m.animationName===name)||(index===0?entry.motion:null);
  viewer.animationCrossfadeDuration=0;viewer.animationName=name;await viewer.updateComplete;if(run!==epoch||request!==selection||motionRequest!==motionSequence)return;seekMotion(0);
  $('#motion-low').textContent=motionConfig?.startLabel||'起点';$('#motion-high').textContent=motionConfig?.endLabel||'终点';$('label[for="motion-progress"]').textContent=motionConfig?.progressLabel||'运动进度';showMotionProgress();
}
function mechanisms(){return catalog?.ui?.mechanisms?.filter(g=>g.modelIndex===active)||[];}
function updateMotionUI(){
  const groups=mechanisms(),g=groups[mechanismIndex],ready=Boolean(g?.animationName&&viewer.availableAnimations?.includes(g.animationName));
  $('#motion').hidden=!partsUI.isAssembly()||!groups.length;$('#motion-controls').hidden=!ready||isOperation278()||isSequence270(); updateSequence270(); updateTransportControls(); updateOperation278();
  $('#mechanism-note').textContent=g?.note||'';
}
async function selectMechanism(index){
  const run=epoch,request=++mechanismSequence,g=mechanisms()[index];if(!g)return;
  if(mechanismIndex===index&&$('#motion-modes').children[index]?.classList.contains('active'))return;
  const wasSequence=isSequence270();mechanismIndex=index;stopMotion();pauseOperation278();
  if(!isOperation278())operation278?.mesh.suspend();
  const clip=viewer.availableAnimations.indexOf(g.animationName);
  // The disassembly clip has its own display datum. The operation controller keeps its current pose.
  if(viewer.availableAnimations.length)await selectMotion(clip<0?0:clip);
  if(run!==epoch||request!==mechanismSequence)return;
  await partsUI.setScope(g.partIds);if(run!==epoch||request!==mechanismSequence)return;
  for(const [i,b]of [...$('#motion-modes').children].entries()){b.classList.toggle('active',i===index);b.setAttribute('aria-pressed',String(i===index));}
  updateMotionUI();document.documentElement.dataset.mechanism=g.id;
  if(g.id==='sequence270'&&!wasSequence){sequence270Camera={orbit:viewer.cameraOrbit,target:viewer.cameraTarget};fitSequence270(true);}
  else if(wasSequence&&g.id!=='sequence270'&&sequence270Camera){viewer.cameraOrbit=sequence270Camera.orbit;viewer.cameraTarget=sequence270Camera.target;viewer.jumpCameraToGoal();sequence270Camera=null;}
  updateSequence270();
}
function configureMotion(){
  stopMotion();mechanismIndex=0;$('#motion-modes').replaceChildren();$('#motion-modes').hidden=false;
  for(const [i,g]of mechanisms().entries()){const b=document.createElement('button');b.type='button';b.textContent=g.label;b.onclick=()=>selectMechanism(i).catch(e=>tell('联动切换失败：'+e.message,true));$('#motion-modes').append(b);}
  updateMotionUI();
}
function tell(message,error=false){status.textContent=message;status.classList.toggle('error',error);}
function assert(ok){if(!ok)throw Error('预览包格式或完整性不正确');}
function urlAt(value,parent){
  const u=new URL(value,parent);
  const same=u.origin===location.origin,github=u.hostname==='raw.githubusercontent.com'||u.hostname.endsWith('.github.io');
  assert(!u.username&&!u.password&&!u.hash&&!u.search&&(same||(u.protocol==='https:'&&github)));
  assert(u.protocol==='https:'||(same&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)));
  return u;
}
function hex(buffer){return [...new Uint8Array(buffer)].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function bytes(url,limit,signal,progress){
  const r=await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer',cache:url.pathname.endsWith('.enc')?'force-cache':'no-store'});
  if(!r.ok)throw Error('下载失败（HTTP '+r.status+'），请稍后重试');
  if(!r.body){const b=await r.arrayBuffer();assert(b.byteLength<=limit);return b;}
  const reader=r.body.getReader(),parts=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('预览包超过本页大小限制');}parts.push(value);progress?.(size);}
  const result=new Uint8Array(size);let offset=0;for(const p of parts){result.set(p,offset);offset+=p.length;}return result.buffer;
}
async function json(url,limit,signal){return JSON.parse(new TextDecoder().decode(await bytes(url,limit,signal)));}
function descriptor(d){assert(d&&/^data\/[a-f0-9]{64}\.enc$/.test(d.path)&&/^[a-f0-9]{64}$/.test(d.sha256)&&d.path==='data/'+d.sha256+'.enc'&&Number.isSafeInteger(d.bytes)&&d.bytes>=32&&d.bytes<=64*1024*1024+32);}
async function decrypt(d,aad,k,parent,signal,progress){
  descriptor(d);const b=await bytes(urlAt(d.path,parent),d.bytes,signal,progress);assert(b.byteLength===d.bytes&&hex(await crypto.subtle.digest('SHA-256',b))===d.sha256);
  const a=new Uint8Array(b);assert(new TextDecoder().decode(a.slice(0,4))==='RPV1');
  return crypto.subtle.decrypt({name:'AES-GCM',iv:a.slice(4,16),additionalData:encoder.encode(aad),tagLength:128},k,a.slice(16));
}
let viewerReady;
const assetCache=new Map();
async function segmentedGlb(entry,k,parent,signal,progress){
  let received=0;
  async function asset(d){
    if(assetCache.has(d.sha256))return assetCache.get(d.sha256);
    const data=await decrypt(d,d.aad,k,parent,signal);
    assert(data.byteLength===d.plainBytes&&hex(await crypto.subtle.digest('SHA-256',data))===d.plainSha256);
    if(signal.aborted)throw new DOMException('Preview locked or switched','AbortError');
    assetCache.set(d.sha256,data);received+=d.bytes;progress?.(received);return data;
  }
  const layout=await asset(entry.layout),segments=new Array(entry.segments.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,entry.segments.length)},async()=>{while(cursor<entry.segments.length){const i=cursor++;segments[i]=await asset(entry.segments[i]);}}));
  assert(!signal.aborted);const size=segments.reduce((n,b)=>n+b.byteLength,0),out=new Uint8Array(28+layout.byteLength+size),h=new DataView(out.buffer);
  h.setUint32(0,0x46546c67,true);h.setUint32(4,2,true);h.setUint32(8,out.length,true);h.setUint32(12,layout.byteLength,true);h.setUint32(16,0x4e4f534a,true);out.set(new Uint8Array(layout),20);
  h.setUint32(20+layout.byteLength,size,true);h.setUint32(24+layout.byteLength,0x004e4942,true);let offset=28+layout.byteLength;
  for(const b of segments){out.set(new Uint8Array(b),offset);offset+=b.byteLength;}return out.buffer;
}
function prepareViewer(){
  if(!viewerReady){window.ModelViewerElement={meshoptDecoderLocation:new URL('./meshopt_decoder.js',import.meta.url).href};viewerReady=import('./model-viewer.min.js').then(()=>customElements.whenDefined('model-viewer'));}
  return viewerReady;
}
function clearState(){
  clearOperation278();clearSequence270();stopMotion();partsUI.reset(true);plainCache.clear();assetCache.clear();pendingModels.clear();$('#motion').hidden=true;
  epoch++;selection++;controller?.abort();controller=null;key=null;catalog=null;base=null;active=-1;loadingIndex=-1;motionConfig=null;
  mainIndex=-1;revisionIndex=-1;revisionLoading=-1;revisionRequest++;revisionViewer.removeAttribute('src');delete revisionViewer.dataset.loaded;$('#revision-select').replaceChildren();$('#revision-retry').hidden=true;
  viewer.removeAttribute('src');for(const url of cache.values())URL.revokeObjectURL(url);cache.clear();
  $('#preview').hidden=true;$('#gate').hidden=false;$('#access-key').value='';$('#title').textContent='模型预览';$('#note').textContent='输入单独收到的访问密钥，解锁本次预览。';
  delete document.documentElement.dataset.loaded;delete document.documentElement.dataset.error;
}
async function modelUrl(index,run,progress){
  if(cache.has(index))return cache.get(index);
  if(pendingModels.has(index))return pendingModels.get(index);
  const entry=catalog.models[index],k=key,parent=base,signal=controller.signal;
  const task=(async()=>{
    const data=entry.transport==='segmented-glb-v2'?await segmentedGlb(entry,k,parent,signal,progress):await decrypt(entry,entry.aad,k,parent,signal,progress);
    assert(data.byteLength===entry.plainBytes&&hex(await crypto.subtle.digest('SHA-256',data))===entry.plainSha256);
    assert(new DataView(data).getUint32(0,true)===0x46546c67);
    if(run!==epoch)return null;
    plainCache.set(index,data);const url=URL.createObjectURL(new Blob([data],{type:'model/gltf-binary'}));cache.set(index,url);return url;
  })();
  pendingModels.set(index,task);
  try{return await task;}finally{if(pendingModels.get(index)===task)pendingModels.delete(index);}
}
async function selectRevision(index){
  if(!catalog?.ui.revisionModelIndices.includes(index))return;
  const entry=catalog.models[index];
  if(index===revisionLoading){if(partsUI.isRevision())tell('正在加载'+entry.label+'…');return;}
  if(index===revisionIndex&&revisionViewer.loaded&&revisionViewer.src===cache.get(index)){if(partsUI.isRevision())tell(entry.label+'已加载，可旋转查看');return;}
  const run=epoch,request=++revisionRequest;revisionIndex=index;revisionLoading=index;
  revisionViewer.removeAttribute('src');delete revisionViewer.dataset.loaded;$('#revision-retry').hidden=true;
  const report=message=>{if(run===epoch&&request===revisionRequest&&partsUI.isRevision())tell(message);};
  report('正在加载'+entry.label+'…');
  try{
    await prepareViewer();await revisionViewer.updateComplete;if(run!==epoch||request!==revisionRequest)return;
    const url=await modelUrl(index,run,n=>report('正在下载'+entry.label+'：'+(n/1048576).toFixed(2)+' MB'));
    if(run!==epoch||request!==revisionRequest)return;
    revisionViewer.cameraOrbit='35deg 65deg auto';revisionViewer.cameraTarget='auto auto auto';revisionViewer.alt=entry.label;revisionViewer.src=url;
    report('解密完成，正在显示'+entry.label+'…');
  }catch(e){if(run===epoch&&request===revisionRequest){revisionLoading=-1;$('#revision-retry').hidden=false;if(partsUI.isRevision())tell(e.name==='OperationError'?'修订模型解密失败，文件可能已损坏':e.message,true);}}
}
async function selectModel(index){
  if(index===loadingIndex)return;
  if(index===active&&document.documentElement.dataset.loaded===String(index)&&viewer.src===cache.get(index)){
    $('#motion').hidden=!partsUI.isAssembly()||!(viewer.availableAnimations?.length);if(partsUI.isAssembly())tell(catalog.models[index].label+'已加载，可旋转查看');return;
  }
  const run=epoch,request=++selection,entry=catalog.models[index];active=index;
  loadingIndex=index;
  stopMotion();partsUI.reset();$('#motion').hidden=true;viewer.removeAttribute('src');
  delete document.documentElement.dataset.loaded;delete document.documentElement.dataset.error;
  if(partsUI.isAssembly())tell('正在加载'+entry.label+'…');
  try{
    await prepareViewer();await viewer.updateComplete;if(run!==epoch||request!==selection)return;
    const objectUrl=await modelUrl(index,run,n=>{if(run===epoch&&request===selection&&partsUI.isAssembly())tell('正在下载'+entry.label+'：'+(n/1048576).toFixed(2)+' MB');});
    if(run!==epoch||request!==selection)return;if(partsUI.isAssembly())tell('解密完成，正在显示'+entry.label+'…');viewer.src=objectUrl;
  }catch(e){if(run===epoch&&request===selection){loadingIndex=-1;tell(e.name==='OperationError'?'模型解密失败，文件可能已损坏或密钥不匹配':e.message,true);document.documentElement.dataset.error='true';}}
}
async function getPackage(){
    const source=await json(new URL('./source.json',location.href),4096),manifestUrl=urlAt(source.manifest,location.href);
    const manifest=await json(manifestUrl,16384);assert(manifest.version===1&&/^[a-f0-9]{32}$/.test(manifest.packageId));
    return {manifest,manifestUrl,scope:manifestUrl.href+'#'+manifest.packageId};
}
async function openPackage(candidate,pkg,run,save){
    const {manifest,manifestUrl}=pkg,signal=controller.signal;
    const plain=await decrypt(manifest.catalog,'rp1:'+manifest.packageId+':catalog',candidate,manifestUrl,signal);
    const unlocked=JSON.parse(new TextDecoder().decode(plain));
    assert(unlocked.version===1&&unlocked.packageId===manifest.packageId&&typeof unlocked.title==='string'&&typeof unlocked.note==='string'&&Array.isArray(unlocked.models)&&unlocked.models.length>0&&unlocked.models.length<=20);
    for(const [i,m]of unlocked.models.entries()){
      assert(typeof m.label==='string'&&m.aad==='rp1:'+manifest.packageId+':model:'+i&&/^[a-f0-9]{64}$/.test(m.plainSha256)&&Number.isSafeInteger(m.plainBytes)&&m.plainBytes>=20&&m.plainBytes<=64*1024*1024);
      if(m.transport==='segmented-glb-v2'){
        assert(Array.isArray(m.segments)&&m.segments.length>0&&m.segments.length<=500);
        for(const d of [m.layout,...m.segments]){descriptor(d);assert(/^[a-f0-9]{64}$/.test(d.plainSha256)&&d.aad==='rp2:'+manifest.packageId+':asset:'+d.plainSha256&&Number.isSafeInteger(d.plainBytes)&&d.plainBytes>0&&d.bytes===d.plainBytes+32);}
        assert(m.layout.plainBytes%4===0&&28+m.layout.plainBytes+m.segments.reduce((n,d)=>n+d.plainBytes,0)===m.plainBytes);
      }else{assert(!m.transport);descriptor(m);}
    }
    const ui=unlocked.ui,indices=ui?.revisionModelIndices;
    assert(Number.isInteger(ui?.mainModelIndex)&&ui.mainModelIndex>=0&&ui.mainModelIndex<unlocked.models.length&&Array.isArray(indices)&&new Set(indices).size===indices.length&&indices.every(i=>Number.isInteger(i)&&i>=0&&i<unlocked.models.length&&i!==ui.mainModelIndex));
    assert(indices.length+1===unlocked.models.length);
    if(run!==epoch)return;key=candidate;catalog=unlocked;base=manifestUrl;mainIndex=ui.mainModelIndex;
    $('#title').textContent=catalog.title;$('#note').textContent=catalog.note;
    for(const i of indices){const option=document.createElement('option');option.value=String(i);option.textContent=catalog.models[i].label;$('#revision-select').append(option);}
    $('#mode-revision').disabled=!indices.length;$('#view-modes').hidden=false;
    $('#gate').hidden=true;$('#preview').hidden=false;
    if(save)try{await rememberKey(pkg.scope,pageIdentity,candidate);$('#forget-device').hidden=false;$('#device-status').textContent='已记住此设备；下次打开本页会自动解锁。';}catch{$('#device-status').textContent='此浏览器无法保存登录，本次仍可正常预览。';}
    try{sessionStorage.removeItem(lockFlag);}catch{}
    if(run===epoch)partsUI.setMode('assembly');
}
async function unlock(value,save,fromDevice=false){
  if(!globalThis.isSecureContext||!crypto.subtle){tell('请通过 HTTPS 或本机 localhost 打开预览',true);return;}
  clearState();const run=epoch;controller=new AbortController();$('#unlock').disabled=true;tell(fromDevice?'正在使用此设备的登录记录…':'正在验证访问密码…');
  try{const pkg=await getPackage(),candidate=fromDevice?value:await importAccessKey(value,pkg.manifest);await openPackage(candidate,pkg,run,save);}
  catch(e){if(run===epoch){clearState();tell(e.name==='OperationError'?'访问密码或密钥不正确，或预览包已被修改':e.message,true);document.documentElement.dataset.error='true';}}
  finally{$('#unlock').disabled=false;}
}
$('#unlock-form').addEventListener('submit',async e=>{
  e.preventDefault();if($('#unlock').disabled)return;const value=$('#access-key').value;$('#access-key').value='';if(!value)return;await unlock(value,$('#remember-device').checked);
});
$('#lock').addEventListener('click',()=>{try{sessionStorage.setItem(lockFlag,'1');}catch{}clearState();tell('预览已锁定');$('#access-key').focus();});
$('#forget-device').addEventListener('click',async()=>{
  $('#forget-device').disabled=true;try{await forgetPageKeys(pageIdentity);try{sessionStorage.setItem(lockFlag,'1');}catch{}clearState();$('#remember-device').checked=false;$('#forget-device').hidden=true;$('#device-status').textContent='';tell('已忘记此设备，下次需要重新输入访问密码。');}catch(e){tell(e.message,true);}finally{$('#forget-device').disabled=false;}
});
$('#reset').addEventListener('click',()=>{const target=partsUI.activeViewer();target.cameraOrbit='35deg 65deg auto';target.cameraTarget='auto auto auto';target.jumpCameraToGoal();});
$('#motion-low').addEventListener('click',()=>moveTo(0));$('#motion-high').addEventListener('click',()=>moveTo(1));
$('#motion-progress').addEventListener('input', e => dragMotion(Number(e.target.value) / 1000));
$('#motion-play').addEventListener('click', () => motionRun ? stopMotion() : playMotion(motionPlayback().mode));
$('#motion-forward').addEventListener('click', () => playMotion('rotation', 1));
$('#motion-reverse').addEventListener('click', () => playMotion('rotation', -1));
$('#motion-pause').addEventListener('click', stopMotion);
$('#revision-select').addEventListener('change',()=>selectRevision(Number($('#revision-select').value)));
$('#revision-retry').addEventListener('click',()=>selectRevision(Number($('#revision-select').value)));
revisionViewer.addEventListener('load',()=>{if(catalog&&cache.get(revisionIndex)===revisionViewer.src){revisionLoading=-1;revisionViewer.dataset.loaded=String(revisionIndex);if(partsUI.isRevision())tell(catalog.models[revisionIndex].label+'已加载，可旋转查看');}});
revisionViewer.addEventListener('error',()=>{if(catalog){revisionLoading=-1;$('#revision-retry').hidden=false;if(partsUI.isRevision())tell('修订模型显示失败，请重新加载',true);}});
viewer.addEventListener('load',async()=>{
  const run=epoch,request=selection;if(!catalog||cache.get(active)!==viewer.src)return;
  try{
    setupSequence270();await configureMotion();if(run!==epoch||request!==selection||!catalog)return;
    await partsUI.configure(catalog.models[active],plainCache.get(active));if(run!==epoch||request!==selection||!catalog)return;
    await selectMechanism(0);if(run!==epoch||request!==selection||!catalog)return;
    loadingIndex=-1;if(partsUI.isAssembly())tell(catalog.models[active].label+'已加载，可旋转查看');document.documentElement.dataset.loaded=String(active);
  }catch(e){if(run===epoch&&request===selection){loadingIndex=-1;document.documentElement.dataset.error='true';if(partsUI.isAssembly())tell('装配显示初始化失败：'+e.message,true);}}
});
viewer.addEventListener('error',()=>{if(catalog){loadingIndex=-1;if(partsUI.isAssembly())tell('装配体显示失败，点击“装配体”可重试',true);document.documentElement.dataset.error='true';}});
window.addEventListener('pagehide',clearState);
async function restoreDevice(){
  $('#unlock').disabled=true;
  try{const pkg=await getPackage(),saved=await rememberedKey(pkg.scope);if(saved){$('#forget-device').hidden=false;$('#remember-device').checked=true;$('#device-status').textContent='此设备已保存登录记录。';let locked=false;try{locked=sessionStorage.getItem(lockFlag)==='1';}catch{}if(!locked)await unlock(saved,false,true);}}
  catch{}finally{$('#unlock').disabled=false;document.documentElement.dataset.authReady='true';}
}
// Reuses model-viewer's public animation API; clips are compiled by the same
// pure evaluator used by the STEP render module. No scene-symbol mutation.
let sequence270=null,sequence270Camera=null;
function isSequence270(){return mechanisms()[mechanismIndex]?.id==='sequence270';}
function setupSequence270(){
 sequence270=null;sequence270Camera=null;
 const buffer=plainCache.get(active);if(!buffer)return;
 const size=new DataView(buffer).getUint32(12,true),j=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,size)));
 if(j.extras?.sequence270)sequence270=createSequencePlayer(j.extras.sequence270.data);
 setupOperation278(j.extras?.operation278);
 $('#sequence270-boundary-list').replaceChildren(...(sequence270?.data.unresolved||[]).map(issue=>{const li=document.createElement('li');li.textContent=issue.problem;return li;}));
}
function clearSequence270(){sequence270=null;sequence270Camera=null;$('#sequence270').hidden=true;for(const id of ['sequence270-stage','sequence270-note','sequence270-blocked','sequence270-boundary-list'])$('#'+id).replaceChildren();}
function updateSequence270(){
 const panel=$('#sequence270');if(!sequence270){panel.hidden=true;return;}
 panel.hidden=!partsUI.isAssembly()||!isSequence270();
 if(panel.hidden)return;
 const p=sequence270,clock=viewer.currentTime||0,state=p.at(Math.abs(clock-p.duration)<1e-5?p.duration:clock),stage=state.stage;
 $('#sequence270-progress').value=String(Math.round(state.time/p.duration*1000));
 $('#sequence270-stage').textContent=`${state.stageIndex+1}/${p.stages.length} · ${state.blocked?'已停在阻塞前：':''}${stage?.label||'装配零位'} · ${state.time.toFixed(2)} / ${p.duration.toFixed(2)} s`;
 $('#sequence270-note').textContent=(stage?.kind==='park'?'此段为脱离后的展示排布。 ':'')+(stage?.note||'')+' '+(p.data.status?.startsWith('SAFE_PREFIX')?'本次只包含局部拆卸前缀。':'当前为拆装候选。')+'未验证部分不代表机械可拆通过。';
 const held=(p.data.heldPartIds||[]).map(id=>p.parts.find(part=>part.id===id)?.name||id);
 $('#sequence270-blocked').textContent=p.data.unresolved?.some(v=>v.blocking)?(p.blockedStage?'当前候选只播放至阻塞前。':'仅播放当前已给出的阶段，其余零件保持原位。')+p.data.unresolved.filter(v=>v.blocking).map(v=>v.problem).join(' '):(held.length?'连接尚未定义，原位保留：'+held.join('、')+'。':'');
 document.documentElement.dataset.sequence270Time=String(state.time);
}
function fitSequence270(allStages=false,reviewAngle=false){
 if(!sequence270)return;
 const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity],points=[],p=sequence270;
 // Playback fits the full path once. The explicit fit button frames the current
 // pose, so the final three columns do not shrink to the transfer corridor.
 for(const time of (allStages?[0,...p.stages.map(s=>Math.min(s.end,p.duration))]:[viewer.currentTime||0])){
  const frame=p.at(time);
  for(const part of p.targets){if(!part.boundsMm)continue;const m=stateMatrix(frame.states[part.id],true);
   for(let i=0;i<8;i++){const a=part.boundsMm[(i>>0)&1][0],b=part.boundsMm[(i>>1)&1][1],c=part.boundsMm[(i>>2)&1][2],v=[a*.001,c*.001,-b*.001],q=[0,1,2].map(k=>m[k]*v[0]+m[4+k]*v[1]+m[8+k]*v[2]+m[12+k]);if(reviewAngle)points.push(q);for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],q[k]);hi[k]=Math.max(hi[k],q[k]);}}
  }
 }
 const center=lo.map((v,k)=>(v+hi[k])/2),radius=Math.hypot(...lo.map((v,k)=>(hi[k]-v)/2)),orbit=viewer.getCameraOrbit(),fov=viewer.getFieldOfView()*Math.PI/180,aspect=Math.max(.2,viewer.clientWidth/viewer.clientHeight),vertical=Math.min(fov,2*Math.atan(Math.tan(fov/2)*aspect));
 let theta=orbit.theta,phi=orbit.phi,distance=1.15*radius/Math.sin(vertical/2);
 if(reviewAngle){
  theta=50*Math.PI/180;phi=55*Math.PI/180;
  const direction=[Math.sin(phi)*Math.sin(theta),Math.cos(phi),Math.sin(phi)*Math.cos(theta)],right=[Math.cos(theta),0,-Math.sin(theta)],up=[-Math.cos(phi)*Math.sin(theta),Math.sin(phi),-Math.cos(phi)*Math.cos(theta)],dot=(a,b)=>a.reduce((n,v,k)=>n+v*b[k],0),projected=points.map(q=>{const v=q.map((x,k)=>x-center[k]);return[dot(v,right),dot(v,up)];});
  const dx=(Math.min(...projected.map(v=>v[0]))+Math.max(...projected.map(v=>v[0])))/2,dy=(Math.min(...projected.map(v=>v[1]))+Math.max(...projected.map(v=>v[1])))/2;for(let k=0;k<3;k++)center[k]+=dx*right[k]+dy*up[k];
  distance=Math.max(.02,...points.map(q=>{const v=q.map((x,k)=>x-center[k]);return dot(v,direction)+Math.max(Math.abs(dot(v,up))/(.72*Math.tan(fov/2)),Math.abs(dot(v,right))/(.85*Math.tan(fov/2)*aspect));}));
 }
 viewer.cameraTarget=center.map(v=>v+'m').join(' ');viewer.cameraOrbit=`${theta}rad ${phi}rad ${distance}m`;viewer.jumpCameraToGoal();
}
function sequence270Seek(time){if(!sequence270)return;stopMotion();seekMotion(Math.min(sequence270.duration,Math.max(0,time)));showMotionProgress();}
function sequence270Step(direction){const t=viewer.currentTime||0,p=sequence270;if(!p)return;const ends=[0,...p.stages.map(s=>s.end).filter(t=>t<=p.duration)],target=direction>0?ends.find(v=>v>t+1e-5):ends.filter(v=>v<t-1e-5).at(-1);sequence270Seek(target??(direction>0?p.duration:0));}
function sequence270Play(direction){
 if(!sequence270||!isSequence270())return;stopMotion();const run=epoch,p=sequence270;let time=viewer.currentTime||0,last=performance.now();if((direction>0&&time>=p.duration-1e-5)||(direction<0&&time<=1e-5))return;
 seekMotion(time);fitSequence270(true);
 const frame=now=>{if(run!==epoch||!isSequence270()||!partsUI.isAssembly())return;time=Math.min(p.duration,Math.max(0,time+(now-last)/1000*direction));last=now;seekMotion(time);showMotionProgress();if(direction>0?time<p.duration:time>0)motionFrame=requestAnimationFrame(frame);else motionFrame=0;};motionFrame=requestAnimationFrame(frame);
}
$('#sequence270-forward').onclick=()=>sequence270Play(1);$('#sequence270-reverse').onclick=()=>sequence270Play(-1);$('#sequence270-pause').onclick=stopMotion;$('#sequence270-prev').onclick=()=>sequence270Step(-1);$('#sequence270-next').onclick=()=>sequence270Step(1);$('#sequence270-fit').onclick=()=>fitSequence270(false,true);
$('#sequence270-progress').oninput=()=>sequence270Seek(sequence270.duration*Number($('#sequence270-progress').value)/1000);

restoreDevice();
