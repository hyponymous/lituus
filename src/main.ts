// Application entry point. Wiring only — the views own their own markup.
//
// Until the views exist this renders a scratch board so the renderer can be
// looked at in a browser.
import { renderGoban, pointName, type Marker } from './goban.ts';
import { BLACK, WHITE, createPosition, isLegal, play, type Position } from './rules.ts';

function demoPosition(): Position {
  let pos: Position = createPosition(19, 19);
  const opening: [number, number, 1 | -1][] = [
    [3, 3, BLACK],
    [15, 15, WHITE],
    [3, 15, BLACK],
    [15, 3, WHITE],
    [2, 5, BLACK],
    [16, 13, WHITE],
  ];
  for (const [row, col, color] of opening) {
    pos = play(pos, row * pos.cols + col, color).position;
  }
  return pos;
}

function main(): void {
  const app: HTMLElement | null = document.getElementById('app');
  if (!app) throw new Error('missing #app container');

  const board: HTMLElement = document.createElement('div');
  board.className = 'board';
  app.appendChild(board);

  const readout: HTMLElement = document.createElement('p');
  readout.className = 'readout';
  readout.textContent = 'Click an intersection.';
  app.appendChild(readout);

  const pos: Position = demoPosition();
  const markers: Marker[] = [];

  const draw = (): void => {
    renderGoban(pos, board, {
      markers,
      onPoint: (index: number): void => {
        markers.length = 0;
        if (isLegal(pos, index, BLACK)) {
          markers.push({ index, kind: 'guess' });
          readout.textContent = `${pointName(pos, index)} — legal for Black`;
        } else {
          readout.textContent = `${pointName(pos, index)} — not playable`;
        }
        draw();
      },
    });
  };

  draw();
}

main();
