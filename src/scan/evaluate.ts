// Decides front/back + quality status from one analysed frame. Pure, runs on the JS thread.
// Spec: .scratch/scan-cccd/spec.md

export type Side = 'front' | 'back';
export type Model = 'c' | 'd'; // (c) CCCD gắn chip 2021, (d) Căn cước 2024
export type Status = 'noCard' | 'glare' | 'blur' | 'tooSmall' | 'cut' | 'ok';

/** Bounds normalised to the guide frame: 0..1 = inside the frame. */
export type Box = { l: number; t: number; r: number; b: number };
export type OcrLine = Box & { text: string };
/** `face`: the largest detected face centred in the frame, if any. */
export type FrameStats = {
  lines: OcrLine[];
  face: Box | null;
  glare: number;
  sharpness: number;
};

// ponytail: starting guesses — calibrate on a real phone with real cards via the __DEV__ debug line.
export const THRESHOLDS = {
  glare: 0.005, // share of sampled pixels with luma >= 250. Note20: no glare 0.0%, flash hotspot 1.1%+
  sharpness: 300, // variance of the Laplacian on luma. Note20: sharp card 500-2900, moving/defocused 170-380 (OCR misreads below ~300)
  minCardWidth: 0.8, // estimated card width / frame width
  edgeTolerance: 0.04, // estimated card edge may stick out this much (estimate is rough)
};

export const MESSAGES: Record<Status, (side: Side) => string> = {
  noCard: side =>
    `Vui lòng chụp ảnh giấy tờ ${side === 'front' ? 'mặt trước' : 'mặt sau'}`,
  glare: () => 'Ảnh bị lóa',
  blur: () => 'Ảnh bị mờ',
  tooSmall: () => 'Di chuyển gần hơn',
  cut: () => 'Đưa toàn bộ giấy tờ vào khung',
  ok: () => 'Giữ cố định',
};

// Keywords are compared after normalize(): no diacritics, no spaces, upper case.
// Top line of both fronts — but also of driver's licences and other papers, so it never decides the side alone.
const HEADER = ['CONGHOAXAHOICHUNGHIAVIETNAM'];
// Not "Có giá trị đến": driver's licences print it too (seen on device). It stays a bottom anchor.
const FRONT_C = [
  'CONGDAN',
  'CITIZEN',
  'HOVATEN',
  'QUEQUAN',
  'PLACEOFORIGIN',
  'NOITHUONGTRU',
];
const FRONT_D = ['DINHDANH', 'IDENTIFICATIONNUMBER', 'CHUDEM'];
const FRONT_BOTTOM: Record<Model, string[]> = {
  // Expiry (bottom-left) is tiny and often misread on device; residence (bottom-right) is the backup.
  c: ['COGIATRIDEN', 'DATEOFEXPIRY', 'NOITHUONGTRU', 'PLACEOFRESIDENCE'],
  d: ['QUOCTICH', 'NATIONALITY'],
};
// First entry of each list is that back's top anchor.
const BACK_C = [
  'DACDIEMNHANDANG',
  'NGONTRO',
  'INDEXFINGER',
  'CUCTRUONG',
  'TRATTUXAHOI',
  'DIRECTORGENERAL',
];
const BACK_D = [
  'NOICUTRU',
  'DANGKYKHAISINH',
  'PLACEOFBIRTH',
  'BOCONGAN',
  'MINISTRYOFPUBLICSECURITY',
];
const BACK_TOP = [BACK_C[0], BACK_D[0]];

// Where the reference line sits on the card, measured from the official specimens (same for (c) and (d)).
const HEADER_WIDTH = 0.48; // header width / card width
const HEADER_LEFT = 0.29; // header left / card width
const MRZ_WIDTH = 0.89; // ICAO TD1: 30 chars x 2.54mm on an 85.6mm card
const MRZ_LEFT = 0.055;

const VI: Record<string, string> = {};
for (const [base, chars] of [
  ['a', 'àáảãạăằắẳẵặâầấẩẫậ'],
  ['e', 'èéẻẽẹêềếểễệ'],
  ['i', 'ìíỉĩị'],
  ['o', 'òóỏõọôồốổỗộơờớởỡợ'],
  ['u', 'ùúủũụưừứửữự'],
  ['y', 'ỳýỷỹỵ'],
  ['d', 'đð'],
]) {
  for (const c of chars) VI[c] = base;
}

/** Hand-rolled instead of String.normalize('NFD'): Hermes on Android has no ICU to rely on. */
export function normalize(text: string): string {
  const plain = Array.from(
    text.toLowerCase().replace(/[̀-ͯ]/g, ''),
    c => VI[c] ?? c,
  ).join('');
  return plain
    .toUpperCase()
    .replace(/«/g, '<<')
    .replace(/[^A-Z0-9<]/g, '');
}

/** Approximate substring match (Sellers): `needle` occurs in `hay` with at most `maxErr` edits. */
export function fuzzyIncludes(
  hay: string,
  needle: string,
  maxErr: number,
): boolean {
  let prev = Array.from({ length: needle.length + 1 }, (_, i) => i);
  if (prev[needle.length] <= maxErr) return true;
  for (let j = 1; j <= hay.length; j++) {
    const cur = [0];
    for (let i = 1; i <= needle.length; i++) {
      const sub = prev[i - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1);
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, sub);
    }
    if (cur[needle.length] <= maxErr) return true;
    prev = cur;
  }
  return false;
}

// Short keywords must match exactly: "CONGDAN" with 1 edit would hit "BOCONGAN" on the (d) back.
const matches = (n: string, keywords: string[]) =>
  keywords.some(k => fuzzyIncludes(n, k, Math.floor(k.length / 8)));

type Line = OcrLine & { n: string };
const find = (lines: Line[], keywords: string[]) =>
  lines.find(l => matches(l.n, keywords));
const isMrz = (l: Line) => l.n.includes('IDVNM') || l.n.includes('<<');

/** `hasFace`: a face (the portrait) is centred in the frame — required for the front. */
export function detectSide(
  lines: Line[],
  hasFace: boolean,
): {
  side: Side | null;
  model: Model | null;
} {
  const backModel = find(lines, BACK_C)
    ? 'c'
    : find(lines, BACK_D)
    ? 'd'
    : null;
  // (d) back words ("Nơi cư trú", "Bộ Công an") also appear on driver's licences, so a (d) back needs its MRZ.
  if (backModel === 'c' || lines.some(isMrz))
    return { side: 'back', model: backModel };
  const frontModel = find(lines, FRONT_C)
    ? 'c'
    : find(lines, FRONT_D)
    ? 'd'
    : null;
  // ponytail: (d) cards for children under 6 have no portrait, so they never count as a front.
  if (hasFace && frontModel) return { side: 'front', model: frontModel };
  return { side: null, model: null };
}

export type Evaluation = {
  status: Status;
  side: Side | null;
  model: Model | null;
  cardWidth: number | null;
};

export function evaluate(
  stats: FrameStats,
  expected: Side,
  t = THRESHOLDS,
): Evaluation {
  const all: Line[] = stats.lines.map(l => ({ ...l, n: normalize(l.text) }));
  const centred = all.filter(isCentred);
  const hasFace = stats.face != null && isCentred(stats.face);
  const { side, model } = detectSide(centred, hasFace);
  const result = (
    status: Status,
    cardWidth: number | null = null,
  ): Evaluation => ({ status, side, model, cardWidth });

  if (side !== expected) return result('noCard');
  // Glare and blur first: both wipe out OCR text, which would otherwise be reported as "cut".
  if (stats.glare > t.glare) return result('glare');
  if (stats.sharpness < t.sharpness) return result('blur');

  const visible = centred.filter(fullyInside);
  const mrz = visible.filter(isMrz);
  const ref =
    side === 'front'
      ? find(visible, HEADER)
      : mrz.reduce<Line | undefined>(
          (a, l) => (!a || l.r - l.l > a.r - a.l ? l : a),
          undefined,
        );
  if (!ref) return result('cut');

  const [widthShare, leftShare] =
    side === 'front' ? [HEADER_WIDTH, HEADER_LEFT] : [MRZ_WIDTH, MRZ_LEFT];
  const cardWidth = (ref.r - ref.l) / widthShare;
  const cardLeft = ref.l - leftShare * cardWidth;
  if (cardWidth < t.minCardWidth) return result('tooSmall', cardWidth);
  if (cardLeft < -t.edgeTolerance || cardLeft + cardWidth > 1 + t.edgeTolerance)
    return result('cut', cardWidth);

  // ponytail: anchors cover top/bottom, the width estimate covers left/right; a strongly rotated card can still hide a corner.
  const anchored =
    side === 'front'
      ? model != null && find(visible, FRONT_BOTTOM[model]) != null
      : find(visible, BACK_TOP) != null && mrz.length >= 3;
  return result(anchored ? 'ok' : 'cut', cardWidth);
}

function inRange(v: number, tolerance: number) {
  return v >= -tolerance && v <= 1 + tolerance;
}

function isCentred(b: Box) {
  return inRange((b.l + b.r) / 2, 0) && inRange((b.t + b.b) / 2, 0);
}

/** Fully inside the guide frame, allowing 2% for text touching the border. */
function fullyInside(b: Box) {
  return [b.l, b.r, b.t, b.b].every(v => inRange(v, 0.02));
}
