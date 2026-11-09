// 自造 fixture：值 import（不是 import type）-> 不改，诚实上报
import { Tone } from "./tone.ts";

export const pick = Tone.A;
export const objectForm = { Tone };
