// Print KataGo's own V7 input tensor for a position we choose, as JSON.
//
//   c++ -std=c++17 -O1 -I$KATAGO_SRC/cpp -o dump-inputs dump-inputs.cpp <katago sources>
//   ./dump-inputs 8 B:Q16
//
// `experiments/katago/README.md` has the exact build line, which is long because
// this deliberately compiles only the files `fillRowV7` needs rather than the
// whole engine — no GPU backend, no search, no network.
//
// Why this exists: every other instrument in this directory compares *outputs*.
// When our forward pass disagreed with KataGo's on positions with an odd number
// of stones, a chain of sound-looking arguments — the network cannot see colour,
// every colour-dependent global is verified, komi is eliminated by measurement —
// kept concluding that the input tensors must be identical, while the outputs
// kept saying otherwise. See `docs/exploration-forward-pass-parity.md` §5.2 and
// §5.3. This stops arguing about the tensor and prints it.
//
// It calls `NNInputs::fillRowV7` directly, which is the same function the engine
// calls, so there is nothing between this output and the truth.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <iostream>

#include "game/board.h"
#include "game/boardhistory.h"
#include "game/rules.h"
#include "neuralnet/nninputs.h"

using namespace std;

// A GTP point like "Q16" on a board of this size. Column letters skip I.
static Loc parsePoint(const string& text, const Board& board) {
  if(text == "pass")
    return Board::PASS_LOC;
  static const string letters = "ABCDEFGHJKLMNOPQRSTUVWXYZ";
  int x = (int)letters.find(toupper(text[0]));
  int y = board.y_size - atoi(text.c_str() + 1);
  return Location::getLoc(x, y, board.x_size);
}

int main(int argc, char** argv) {
  Board::initHash();

  if(argc < 2) {
    fprintf(stderr, "usage: dump-inputs <komi> [B:Q16 W:D4 ...]\n");
    return 1;
  }
  float komi = (float)atof(argv[1]);

  const int size = 19;
  Board board(size, size);

  // Japanese as lituus uses it, and as the GTP override in the other
  // instruments sets it: simple ko, territory scoring, seki tax, no suicide,
  // no button, no handicap bonus.
  Rules rules(
    Rules::KO_SIMPLE, Rules::SCORING_TERRITORY, Rules::TAX_SEKI,
    false, false, Rules::WHB_ZERO, false, komi
  );

  Player nextPla = P_BLACK;
  BoardHistory hist(board, nextPla, rules, 0, BoardHistoryModes(false, false));

  for(int i = 2; i < argc; i++) {
    string arg = argv[i];
    size_t colon = arg.find(':');
    if(colon == string::npos) {
      fprintf(stderr, "bad move '%s', want B:Q16\n", arg.c_str());
      return 1;
    }
    Player pla = (toupper(arg[0]) == 'B') ? P_BLACK : P_WHITE;
    Loc loc = parsePoint(arg.substr(colon + 1), board);
    hist.makeBoardMoveAssumeLegal(board, loc, pla, NULL);
    nextPla = getOpp(pla);
  }

  const int numSpatial = NNInputs::NUM_FEATURES_SPATIAL_V7;
  const int numGlobal = NNInputs::NUM_FEATURES_GLOBAL_V7;
  vector<float> rowBin((size_t)numSpatial * size * size, 0.0f);
  vector<float> rowGlobal((size_t)numGlobal, 0.0f);

  MiscNNInputParams params;
  // NHWC, so the tensor is laid out point-major exactly as `features-v7.ts`
  // writes it and the two can be compared without transposing either.
  NNInputs::fillRowV7(
    board, hist, nextPla, params, size, size, true, rowBin.data(), rowGlobal.data()
  );

  printf("{\"size\":%d,\"komi\":%g,\"toPlay\":\"%s\",\n",
         size, (double)komi, nextPla == P_BLACK ? "B" : "W");
  printf(" \"spatial\":[");
  for(size_t i = 0; i < rowBin.size(); i++)
    printf("%s%g", i ? "," : "", (double)rowBin[i]);
  printf("],\n \"global\":[");
  for(size_t i = 0; i < rowGlobal.size(); i++)
    printf("%s%.9g", i ? "," : "", (double)rowGlobal[i]);
  printf("]}\n");
  return 0;
}
