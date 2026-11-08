import {
  evaluate,
  fuzzyIncludes,
  normalize,
  type OcrLine,
} from '../src/scan/evaluate';
import { measureLuma } from '../src/scan/measureLuma';

const line = (
  text: string,
  l: number,
  t: number,
  r: number,
  b: number,
): OcrLine => ({ text, l, t, r, b });
const PORTRAIT = { l: 0.04, t: 0.35, r: 0.25, b: 0.75 }; // face in the front's photo
const good = { face: PORTRAIT, glare: 0, sharpness: 500 };
const HEADER = line('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', 0.3, 0.05, 0.78, 0.1);
const MRZ = [
  line('IDVNM0970287661001097028766<2', 0.05, 0.66, 0.94, 0.74),
  line('9709177M3709175VNM<<<<<<<<<<<2', 0.05, 0.77, 0.94, 0.85),
  line('VUONG<<TAT<VU<<<<<<<<<<<<<<<<<', 0.05, 0.88, 0.94, 0.96),
];
const FRONT_C = [
  HEADER,
  line('CĂN CƯỚC CÔNG DÂN', 0.3, 0.27, 0.78, 0.34),
  line('Có giá trị đến:', 0.02, 0.88, 0.2, 0.93),
];
const FRONT_D = [
  HEADER,
  line(
    'Số định danh cá nhân /Personal identification number:',
    0.3,
    0.44,
    0.8,
    0.49,
  ),
  line('Quốc tịch / Nationality:', 0.3, 0.86, 0.6, 0.92),
];
const BACK_C = [
  line('Đặc điểm nhân dạng / Personal identification:', 0.02, 0.02, 0.45, 0.07),
  ...MRZ,
];
const BACK_D = [
  line('Nơi cư trú / Place of residence:', 0.02, 0.02, 0.4, 0.07),
  line('BỘ CÔNG AN / MINISTRY OF PUBLIC SECURITY', 0.3, 0.55, 0.7, 0.6),
  ...MRZ,
];

test('normalize strips Vietnamese marks and spaces', () => {
  expect(normalize('Cộng hòa xã hội, Đặc điểm « ư')).toBe(
    'CONGHOAXAHOIDACDIEM<<U',
  );
});

test('fuzzyIncludes tolerates OCR noise only up to maxErr', () => {
  expect(
    fuzzyIncludes(
      normalize('CONG HOA XA HOl CHU NGHIA VlET NAM'),
      'CONGHOAXAHOICHUNGHIAVIETNAM',
      3,
    ),
  ).toBe(true);
  expect(fuzzyIncludes('BOCONGAN', 'CONGDAN', 0)).toBe(false);
});

test.each([
  ['front (c)', FRONT_C, 'front', 'c'],
  ['front (d)', FRONT_D, 'front', 'd'],
  ['back (c)', BACK_C, 'back', 'c'],
  ['back (d)', BACK_D, 'back', 'd'],
] as const)('%s fully in frame is ok', (_, lines, side, model) => {
  expect(evaluate({ lines: [...lines], ...good }, side)).toMatchObject({
    status: 'ok',
    side,
    model,
  });
});

test('wrong side, old ID card and empty frame are noCard', () => {
  expect(evaluate({ lines: BACK_C, ...good }, 'front').status).toBe('noCard');
  expect(evaluate({ lines: FRONT_D, ...good }, 'back').status).toBe('noCard');
  expect(
    evaluate(
      {
        lines: [line('GIẤY CHỨNG MINH NHÂN DÂN', 0.3, 0.2, 0.8, 0.3)],
        ...good,
      },
      'front',
    ).status,
  ).toBe('noCard');
  expect(
    evaluate({ lines: [], face: null, glare: 0.5, sharpness: 0 }, 'front')
      .status,
  ).toBe('noCard');
});

test('glare beats blur beats geometry', () => {
  expect(
    evaluate({ ...good, lines: FRONT_C, glare: 0.1, sharpness: 0 }, 'front')
      .status,
  ).toBe('glare');
  expect(
    evaluate({ ...good, lines: FRONT_C, glare: 0, sharpness: 10 }, 'front')
      .status,
  ).toBe('blur');
});

test('small card asks to move closer', () => {
  const far = [
    line(HEADER.text, 0.4, 0.3, 0.7, 0.34),
    line('CĂN CƯỚC CÔNG DÂN', 0.4, 0.4, 0.7, 0.44),
    line('Có giá trị đến:', 0.25, 0.7, 0.35, 0.73),
  ];
  expect(evaluate({ lines: far, ...good }, 'front').status).toBe('tooSmall');
});

test('card sticking out of the frame is cut', () => {
  expect(
    evaluate({ lines: FRONT_C.slice(0, 2), ...good }, 'front').status,
  ).toBe('cut'); // bottom anchor missing
  const shifted = FRONT_C.map(l => ({
    ...l,
    l: l.l - 0.25,
    r: l.r - 0.25,
  })).filter(l => l.l >= 0);
  expect(evaluate({ lines: shifted, ...good }, 'front').status).toBe('cut'); // left edge outside
  expect(evaluate({ lines: BACK_C.slice(0, 3), ...good }, 'back').status).toBe(
    'cut',
  ); // last MRZ line missing
  const overflowing = BACK_D.map(l => ({ ...l, t: l.t - 0.05, b: l.b - 0.05 }));
  expect(evaluate({ lines: overflowing, ...good }, 'back').status).toBe('cut'); // top anchor above the frame
});

test('measureLuma: flat = no sharpness, white = glare, checkerboard = sharp', () => {
  const W = 200;
  const img = (f: (x: number, y: number) => number) =>
    Uint8Array.from({ length: W * W }, (_, i) => f(i % W, Math.floor(i / W)));
  expect(
    measureLuma(
      img(() => 128),
      W,
      1,
      1,
      W - 1,
      W - 1,
    ),
  ).toEqual({ glare: 0, sharpness: 0 });
  expect(
    measureLuma(
      img(() => 255),
      W,
      1,
      1,
      W - 1,
      W - 1,
    ).glare,
  ).toBe(1);
  expect(
    measureLuma(
      img((x, y) => ((x + y) % 2) * 200),
      W,
      1,
      1,
      W - 1,
      W - 1,
    ).sharpness,
  ).toBeGreaterThan(1000);
});

test('the front needs a face; the back does not', () => {
  expect(
    evaluate({ ...good, lines: FRONT_C, face: null }, 'front').status,
  ).toBe('noCard');
  const offFrame = { ...PORTRAIT, l: -0.4, r: -0.2 }; // face centred outside the guide frame
  expect(
    evaluate({ ...good, lines: FRONT_C, face: offFrame }, 'front').status,
  ).toBe('noCard');
  expect(evaluate({ ...good, lines: BACK_C, face: null }, 'back').status).toBe(
    'ok',
  );
});

test("a driver's licence (same header, has a portrait) is not a CCCD front", () => {
  // Lines as OCR read a real licence on the Note20.
  const licence = [
    HEADER,
    line("GIÂY PHEP LALXE/DRIVER'S LICENSE", 0.3, 0.2, 0.8, 0.3),
    line('Họ tên Full name.', 0.3, 0.35, 0.6, 0.4),
    line('Cỏ giá trị đểnExpires: Không thời hạn', 0.02, 0.85, 0.5, 0.9),
  ];
  expect(evaluate({ ...good, lines: licence }, 'front').status).toBe('noCard');
  const withAddress = [
    ...licence,
    line('Nơi cư trú Address:', 0.3, 0.6, 0.6, 0.65),
  ];
  expect(evaluate({ ...good, lines: withAddress }, 'back').status).toBe(
    'noCard',
  );
});
