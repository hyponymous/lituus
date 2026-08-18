// Board dimensions. Trivial for now; exists so the scaffold has a real
// module to import and the rules engine has somewhere to put size handling.

/** Board sizes the app expects to encounter, largest first. */
export const BOARD_SIZES: readonly number[] = [19, 13, 9];

export function isSquare(cols: number, rows: number): boolean {
  return cols === rows;
}
