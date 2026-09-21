export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export const createBoard = (size = 19) =>
  Array.from({ length: size }, () => Array(size).fill(EMPTY));

export const cloneBoard = board => board.map(row => [...row]);

export const hashBoard = board => board.map(row => row.join("")).join("/");

const opponent = color => color === BLACK ? WHITE : BLACK;

function neighbors(board, x, y) {
  const size = board.length;
  return [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]
    .filter(([nx,ny]) => nx >= 0 && ny >= 0 && nx < size && ny < size);
}

function collectGroup(board, startX, startY) {
  const color = board[startY][startX];
  const stack = [[startX,startY]];
  const visited = new Set();
  const stones = [];
  const liberties = new Set();

  while (stack.length) {
    const [x,y] = stack.pop();
    const key = `${x},${y}`;
    if (visited.has(key)) continue;
    visited.add(key);
    stones.push([x,y]);

    for (const [nx,ny] of neighbors(board,x,y)) {
      const value = board[ny][nx];
      if (value === EMPTY) liberties.add(`${nx},${ny}`);
      else if (value === color) stack.push([nx,ny]);
    }
  }
  return { stones, liberties };
}

export function applyMove(board, x, y, color, koHash = null) {
  const size = board.length;
  if (x < 0 || y < 0 || x >= size || y >= size)
    return { ok:false, error:"Move is outside the board." };
  if (board[y][x] !== EMPTY)
    return { ok:false, error:"That intersection is already occupied." };

  const next = cloneBoard(board);
  next[y][x] = color;
  const enemy = opponent(color);
  const captured = [];
  const checked = new Set();

  for (const [nx,ny] of neighbors(next,x,y)) {
    if (next[ny][nx] !== enemy) continue;
    const key = `${nx},${ny}`;
    if (checked.has(key)) continue;

    const group = collectGroup(next,nx,ny);
    for (const [gx,gy] of group.stones) checked.add(`${gx},${gy}`);

    if (group.liberties.size === 0) {
      for (const [gx,gy] of group.stones) {
        captured.push({x:gx,y:gy,color:enemy});
        next[gy][gx] = EMPTY;
      }
    }
  }

  const own = collectGroup(next,x,y);
  if (own.liberties.size === 0)
    return { ok:false, error:"Suicide is not legal in this prototype ruleset." };

  const hash = hashBoard(next);
  if (koHash && hash === koHash)
    return { ok:false, error:"Ko: this move immediately recreates the previous position." };

  return { ok:true, board:next, captured, hash };
}
