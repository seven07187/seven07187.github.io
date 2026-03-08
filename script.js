const SUITS = ['spade', 'heart', 'diamond', 'club'];
const NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

// ゲームのステート管理
let State = {
    players: [],
    table: [],            // 現在場に出ているカードの配列
    lastPlayedCards: [],  // 直前に出されたカード（強さ比較用）
    lastPlayerIdx: 0,     // 最後にカードを出したプレイヤーのインデックス
    currentTurn: 0,
    consecutivePasses: 0, // 連続パス数 (場を流す判定用)
    isRevolution: false,
    gameCount: 0,
    nextNormalRank: 1,    // 次に通常上がりした人がなる順位 (1〜5)
    nextFoulRank: 5,      // 次に反則上がりした人がなる順位 (5から減っていく)
    isExchangePhase: false,
    exchangeCount: 0,
    exchangeSelectedIds: [],
    playedCards: {
        joker: 0,
        two: 0,
        ace: 0,
        eight: 0,
        spade3: 0
    }
};

// 待機時間の定数 (ミリ秒)
const WAIT_TIME_CPU_THINK = 1000; // CPUの思考時間
const WAIT_TIME_NEXT_TURN = 800;  // カードを出した後の待機
const WAIT_TIME_CLEAR_TABLE = 1200; // 場を流す時の待機
const WAIT_TIME_PASS_DISPLAY = 1000; // パス表示の持続時間

// カードの強さを計算する関数 (Joker=16, 2=15, A=14, ..., 3=3)
function getCardPower(number, isRevolution) {
    if (number === 0) return 16;
    let power = number;
    if (number === 1) power = 14;
    else if (number === 2) power = 15;
    if (isRevolution) power = 18 - power;
    return power;
}

function getDisplayNumber(num) {
    if (num === 0) return 'Joker';
    const mapping = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
    return mapping[num] || String(num);
}

function createDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let num of NUMBERS) {
            deck.push({ suit, number: num, id: `${suit}-${num}` });
        }
    }
    for (let i = 0; i < 2; i++) {
        deck.push({ suit: 'joker', number: 0, id: `joker-${i}` });
    }
    return deck;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function sortHand(hand) {
    hand.sort((a, b) => {
        const pA = getCardPower(a.number, false);
        const pB = getCardPower(b.number, false);
        if (pA !== pB) return pA - pB;
        return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    });
}

// === ルール判定 ===

function getHandType(cards) {
    if (cards.length === 0) return null;
    const nonJokers = cards.filter(c => c.number !== 0);
    if (nonJokers.length === 0) return { type: 'normal', count: cards.length };
    const firstNum = nonJokers[0].number;
    if (nonJokers.every(c => c.number === firstNum)) return { type: 'normal', count: cards.length };
    if (cards.length >= 3) {
        if (cards.some(c => c.number === 0)) return null;
        const suit = cards[0].suit;
        if (cards.every(c => c.suit === suit)) {
            const powers = cards.map(c => getCardPower(c.number, false)).sort((a, b) => a - b);
            let isSeq = true;
            for (let i = 0; i < powers.length - 1; i++) { if (powers[i + 1] !== powers[i] + 1) { isSeq = false; break; } }
            if (isSeq) return { type: 'stairs', count: cards.length };
        }
    }
    return null;
}

function canPlay(selectedCards) {
    const handType = getHandType(selectedCards);
    if (!handType) return false;
    if (State.lastPlayedCards.length === 0) return true;

    // スペ3返し: 場がジョーカー1枚の時にスペードの3単体を出せる
    if (State.lastPlayedCards.length === 1 && State.lastPlayedCards[0].number === 0) {
        if (selectedCards.length === 1 && selectedCards[0].suit === 'spade' && selectedCards[0].number === 3) return true;
    }
    const lastType = getHandType(State.lastPlayedCards);
    if (handType.type !== lastType.type || handType.count !== lastType.count) return false;
    const currentPower = getMaxPower(selectedCards, State.isRevolution);
    const lastPower = getMaxPower(State.lastPlayedCards, State.isRevolution);
    return currentPower > lastPower;
}

function getMaxPower(cards, isRev) {
    let max = 0;
    cards.forEach(c => { const p = getCardPower(c.number, isRev); if (p > max) max = p; });
    return max;
}

// 反則上がりの判定
// 通常時: 2, Joker(0), 8, スペードの3 で上がると反則
// 革命時: 3, Joker(0), 8 で上がると反則
function isFoulWin(cards, isRevolution) {
    for (let c of cards) {
        if (c.number === 0) return true; // Joker
        if (c.number === 8) return true; // 8切り上がり
        if (isRevolution) {
            if (c.number === 3) return true;
        } else {
            if (c.number === 2) return true;
            if (c.number === 3 && c.suit === 'spade') return true; // スペ3上がり
        }
    }
    return false;
}

// === アクション ===

function playSelectedCards() {
    const selectedIds = Array.from(document.querySelectorAll('#player-hand .card.selected')).map(el => el.dataset.id);
    const selectedCards = State.players[0].hand.filter(c => selectedIds.includes(c.id));
    if (canPlay(selectedCards)) playCards(0, selectedCards);
    else alert('そのカードは出せません');
}

function playCards(playerIdx, cards) {
    const p = State.players[playerIdx];
    const cardIds = cards.map(c => c.id);

    // スペ3返し判定 (場が上書きされる前にチェック)
    let isSpade3Counter = false;
    if (cards.length === 1 && cards[0].suit === 'spade' && cards[0].number === 3 &&
        State.table.length === 1 && State.table[0].number === 0) {
        isSpade3Counter = true;
    }

    p.hand = p.hand.filter(c => !cardIds.includes(c.id));

    State.table = cards;
    State.lastPlayedCards = [...cards];
    State.lastPlayerIdx = playerIdx; // 出し手を記録
    State.consecutivePasses = 0;     // 出し手が出たのでパス数をリセット

    // カードカウントの更新
    for (let c of cards) {
        if (c.number === 0) State.playedCards.joker++;
        else if (c.number === 2) State.playedCards.two++;
        else if (c.number === 1) State.playedCards.ace++;
        else if (c.number === 8) State.playedCards.eight++;
        else if (c.number === 3 && c.suit === 'spade') State.playedCards.spade3++;
    }

    let resetImmediate = false;
    if (cards.some(c => c.number === 8)) resetImmediate = true;
    if (isSpade3Counter) resetImmediate = true;

    const type = getHandType(cards).type;
    if (cards.length >= 4 && (type === 'normal' || type === 'stairs')) State.isRevolution = !State.isRevolution;

    render();

    if (p.hand.length === 0 && !p.rank) {
        if (isFoulWin(cards, State.isRevolution)) {
            // 反則上がり
            p.rank = State.nextFoulRank;
            State.nextFoulRank--;
            p.isFoul = true;
            p.rankName = getRankName(p.rank);
            showFoulEffect();
            // 反則上がりは場を流す（またはそのまま進行するルールのバリエーションがあるが、ここではリセットして次に回す）
            resetImmediate = true;
        } else {
            // 通常上がり
            p.rank = State.nextNormalRank;
            State.nextNormalRank++;
            p.isFoul = false;
            p.rankName = getRankName(p.rank);
        }
    }

    if (resetImmediate) {
        setTimeout(() => {
            clearTable();
            // 8切りやスペ3返し後は、出した人が親となりそのまま手番を開始
            State.currentTurn = playerIdx;
            startTurn();
        }, WAIT_TIME_CLEAR_TABLE);
    } else {
        setTimeout(nextTurn, WAIT_TIME_NEXT_TURN);
    }
}

function handlePass() {
    const p = State.players[0];
    State.consecutivePasses++; // パス数を加算
    showPassEffect();
    render();
    setTimeout(nextTurn, WAIT_TIME_PASS_DISPLAY);
}

function showPassEffect() {
    const overlay = document.getElementById('pass-overlay');
    overlay.classList.add('show');
    setTimeout(() => {
        overlay.classList.remove('show');
    }, WAIT_TIME_PASS_DISPLAY);
}

// 反則上がり表示演出
function showFoulEffect() {
    const overlay = document.getElementById('foul-overlay');
    overlay.classList.add('show');
    setTimeout(() => {
        overlay.classList.remove('show');
    }, WAIT_TIME_PASS_DISPLAY * 1.5);
}

function clearTable() {
    State.table = [];
    State.lastPlayedCards = [];
    State.consecutivePasses = 0;
    State.players.forEach(p => p.passed = false);
    render();
}

function getRankName(rank) {
    return ['大富豪', '富豪', '平民', '貧民', '大貧民'][rank - 1] || 'なし';
}

// === 進行管理 ===

function initGame() {
    if (State.gameCount === 0) {
        State.players = Array.from({ length: 5 }, (_, i) => ({
            id: i, name: i === 0 ? 'あなた' : `CPU ${i}`, isCPU: i !== 0,
            hand: [], rank: null, lastRank: null, rankName: '', passed: false, isFoul: false
        }));
    } else {
        State.players.forEach(p => {
            p.lastRank = p.rank;
            p.hand = []; p.passed = false; p.rank = null; p.rankName = ''; p.isFoul = false;
        });
    }

    State.table = [];
    State.lastPlayedCards = [];
    State.isRevolution = false;
    State.nextNormalRank = 1;
    State.nextFoulRank = 5;
    State.playedCards = { joker: 0, two: 0, ace: 0, eight: 0, spade3: 0 };

    // 2回目以降のゲームは大貧民（前回5位）から開始
    if (State.gameCount > 0) {
        const daichinmin = State.players.find(p => p.lastRank === 5);
        if (daichinmin) {
            State.currentTurn = daichinmin.id;
        } else {
            State.currentTurn = 0;
        }
    } else {
        State.currentTurn = 0;
    }

    let deck = shuffle(createDeck());
    for (let i = 0; deck.length > 0; i++) {
        State.players[i % 5].hand.push(deck.pop());
    }
    State.players.forEach(p => sortHand(p.hand));

    if (State.gameCount > 0) {
        State.isExchangePhase = true;
        document.getElementById('modal-overlay').classList.add('hidden');
        startExchangePhase();
    } else {
        render();
        document.getElementById('modal-overlay').classList.add('hidden');
        startTurn();
    }
}

function startExchangePhase() {
    const p = State.players[0];
    State.exchangeSelectedIds = [];

    if (p.lastRank === 1) { // 大富豪
        State.exchangeCount = 2;
        render(); // render先にしてUIを整える
        document.getElementById('turn-indicator').innerText = '大富豪: 渡すカードを2枚選んで交換ボタンを押してください';
    } else if (p.lastRank === 2) { // 富豪
        State.exchangeCount = 1;
        render();
        document.getElementById('turn-indicator').innerText = '富豪: 渡すカードを1枚選んで交換ボタンを押してください';
    } else if (p.lastRank === 3) { // 平民
        State.exchangeCount = 0;
        render();
        document.getElementById('turn-indicator').innerText = '平民: カード交換なし';
        setTimeout(executeExchange, 2000);
    } else if (p.lastRank === 4) { // 貧民
        State.exchangeCount = 1;
        const strongCards = getStrongestCards(p.hand, 1);
        State.exchangeSelectedIds = strongCards.map(c => c.id);
        render();
        document.getElementById('turn-indicator').innerText = '貧民: 最強カードを自動的に富豪に渡します...';
        setTimeout(executeExchange, 2000);
    } else if (p.lastRank === 5) { // 大貧民
        State.exchangeCount = 2;
        const strongCards = getStrongestCards(p.hand, 2);
        State.exchangeSelectedIds = strongCards.map(c => c.id);
        render();
        document.getElementById('turn-indicator').innerText = '大貧民: 最強カード2枚を自動的に大富豪に渡します...';
        setTimeout(executeExchange, 2000);
    }
}

function getStrongestCards(hand, count) {
    const sorted = [...hand].sort((a, b) => getCardPower(b.number, false) - getCardPower(a.number, false));
    return sorted.slice(0, count);
}

function getWeakestCards(hand, count) {
    const sorted = [...hand].sort((a, b) => getCardPower(a.number, false) - getCardPower(b.number, false));
    return sorted.slice(0, count);
}

function executeExchange() {
    const p1 = State.players.find(p => p.lastRank === 1);
    const p2 = State.players.find(p => p.lastRank === 2);
    const p4 = State.players.find(p => p.lastRank === 4);
    const p5 = State.players.find(p => p.lastRank === 5);

    let p1Give = [], p2Give = [], p4Give = [], p5Give = [];

    if (p1 && p1.isCPU) p1Give = getWeakestCards(p1.hand, 2);
    if (p2 && p2.isCPU) p2Give = getWeakestCards(p2.hand, 1);
    if (p4) p4Give = getStrongestCards(p4.hand, 1);
    if (p5) p5Give = getStrongestCards(p5.hand, 2);

    const p = State.players[0];
    if (p.lastRank === 1) {
        const selectedIds = Array.from(document.querySelectorAll('#player-hand .card.selected')).map(el => el.dataset.id);
        p1Give = p.hand.filter(c => selectedIds.includes(c.id));
    } else if (p.lastRank === 2) {
        const selectedIds = Array.from(document.querySelectorAll('#player-hand .card.selected')).map(el => el.dataset.id);
        p2Give = p.hand.filter(c => selectedIds.includes(c.id));
    }

    if (p1 && p5) {
        p1.hand = p1.hand.filter(c => !p1Give.includes(c));
        p5.hand = p5.hand.filter(c => !p5Give.includes(c));
        p1.hand.push(...p5Give);
        p5.hand.push(...p1Give);
    }
    if (p2 && p4) {
        p2.hand = p2.hand.filter(c => !p2Give.includes(c));
        p4.hand = p4.hand.filter(c => !p4Give.includes(c));
        p2.hand.push(...p4Give);
        p4.hand.push(...p2Give);
    }

    State.players.forEach(player => sortHand(player.hand));
    State.isExchangePhase = false;
    State.exchangeSelectedIds = [];

    document.getElementById('turn-indicator').innerText = 'カード交換完了。ゲームを開始します...';
    render();

    setTimeout(() => {
        startTurn();
    }, 1500);
}

function startTurn() {
    const active = State.players.filter(p => !p.rank);
    if (active.length <= 1) {
        if (active.length === 1) {
            const p = active[0];
            p.rank = State.nextNormalRank; // 最後の1人は残った中で一番上の順位になる
            p.rankName = getRankName(p.rank);
        }
        endGame();
        return;
    }

    const p = State.players[State.currentTurn];

    // パスルール最終調整: 自分の番が回ってきたら確実にパス状態を解除
    if (p.passed) {
        p.passed = false;
        // 描画更新して「パス中」表記を消す
        render();
    }

    if (p.rank) {
        State.currentTurn = (State.currentTurn + 1) % 5;
        setTimeout(startTurn, 10);
        return;
    }

    render();
    if (p.isCPU) setTimeout(playCPU, WAIT_TIME_CPU_THINK);
}

function nextTurn() {
    const activePlayers = State.players.filter(p => !p.rank);

    // パス判定: 最後に出した人以外が全員連続でパスしたか
    if (State.consecutivePasses >= activePlayers.length - 1 && State.table.length > 0) {
        // 場を流す
        setTimeout(() => {
            clearTable();
            // 最後にカードを出した人からターンを開始
            State.currentTurn = State.lastPlayerIdx;
            startTurn();
        }, WAIT_TIME_CLEAR_TABLE);
        return;
    }

    // 次のターンへ
    State.currentTurn = (State.currentTurn + 1) % 5;
    startTurn();
}

// === CPU AI ===

// AI用ヘルパー関数
function countStrongCards(hand) {
    let count = { joker: 0, two: 0, ace: 0, eight: 0, spade3: 0 };
    for (let c of hand) {
        if (c.number === 0) count.joker++;
        else if (c.number === 2) count.two++;
        else if (c.number === 1) count.ace++;
        else if (c.number === 8) count.eight++;
        else if (c.number === 3 && c.suit === 'spade') count.spade3++;
    }
    return count;
}

// 手札の強さを数値化して返す（強カードの数など）
function evaluateHandStrength(hand, isRevolution) {
    let score = 0;
    for (let c of hand) {
        const power = getCardPower(c.number, isRevolution);
        score += power;
    }
    return score / hand.length; // 平均パワー
}

function isWeakHand(hand, isRevolution) {
    const avgPower = evaluateHandStrength(hand, isRevolution);
    // 平均パワーが低いかどうか（例: 7未満など）
    return avgPower < 7;
}

function playCPU() {
    const p = State.players[State.currentTurn];
    // 出せる手をすべて取得 (反則上がりになる手は除外される)
    let playable = getPlayableHands(p.hand);

    if (playable.length === 0) {
        State.consecutivePasses++;
        showPassEffect();
        render();
        setTimeout(nextTurn, WAIT_TIME_PASS_DISPLAY);
        return;
    }

    const handData = countStrongCards(p.hand);
    const isWeak = isWeakHand(p.hand, State.isRevolution);

    // 親の場合 (場が空)
    if (State.lastPlayedCards.length === 0) {
        // 1. 革命の活用: 手札が弱く、4枚以上出せるなら優先(通常ルール時)
        if (!State.isRevolution && isWeak) {
            let revCandidates = playable.filter(cand => cand.length >= 4 && (getHandType(cand).type === 'normal' || getHandType(cand).type === 'stairs'));
            if (revCandidates.length > 0) {
                playCards(State.currentTurn, revCandidates[0]);
                return;
            }
        }

        // 2. 8切りの活用: 手札が弱いか、残り手札が少ない時に優先して場をリセット
        let eightCandidates = playable.filter(cand => cand.some(c => c.number === 8));
        if (eightCandidates.length > 0 && (isWeak || p.hand.length <= 4)) {
            playCards(State.currentTurn, eightCandidates[0]);
            return;
        }

        // 3. フィニッシュ狙い: 手札が少ない時は強いものから出して確実にあがる
        if (p.hand.length <= 3) {
            // 元の配列を変えずに強い順にソートして出す
            let aggressive = [...playable].sort((a, b) =>
                getMaxPower(b, State.isRevolution) - getMaxPower(a, State.isRevolution)
            );
            playCards(State.currentTurn, aggressive[0]);
            return;
        }

        // 基本は最弱カード・ペア・階段から (playable[0]はgetPlayableHandsでセオリー通り優先度順にソート済)
        playCards(State.currentTurn, playable[0]);
        return;
    }

    // 子の場合 (場にカードがある)
    const bestHand = playable[0];
    const maxPower = getMaxPower(bestHand, State.isRevolution);

    // カウンター警戒: 手札がまだ十分にある時のみ考慮
    if (maxPower >= 14 && p.hand.length >= 3) {
        const remainingJokers = 2 - State.playedCards.joker - handData.joker;
        // ジョーカーのカウンターを警戒
        if (remainingJokers > 0 && Math.random() < 0.3) {
            playable = [];
        }

        // スペ3警戒 (自分がジョーカー単体を出す場合)
        if (playable.length > 0 && bestHand.length === 1 && bestHand[0].number === 0) {
            const isSpade3Played = State.playedCards.spade3 > 0 || handData.spade3 > 0;
            if (!isSpade3Played && !State.isRevolution && Math.random() < 0.6) {
                playable = []; // スペ3が残っている通常時ならジョーカー温存を検討
            }
        }
    }

    if (playable.length > 0) {
        // 出し惜しみせず、出せるなら出す (パス誘発・親取り)
        playCards(State.currentTurn, playable[0]);
    } else {
        State.consecutivePasses++;
        showPassEffect();
        render();
        setTimeout(nextTurn, WAIT_TIME_PASS_DISPLAY);
    }
}

function getPlayableHands(hand) {
    let candidates = [];
    if (State.lastPlayedCards.length === 0) {
        // 場が空の場合
        hand.forEach(c => candidates.push([c]));
        const groups = groupByNumber(hand);
        Object.values(groups).forEach(g => {
            for (let i = 2; i <= 4; i++) {
                if (g.length >= i) candidates.push(g.slice(0, i));
            }
        });
        candidates.push(...getStairsInHand(hand));
    } else {
        // 場にカードがある場合
        const lastType = getHandType(State.lastPlayedCards);
        const lastCount = lastType.count;
        if (lastType.type === 'normal') {
            if (lastCount === 1) {
                hand.forEach(c => { if (canPlay([c])) candidates.push([c]); });
            } else {
                const groups = groupByNumber(hand);
                Object.values(groups).forEach(g => {
                    if (g.length >= lastCount) {
                        const sub = g.slice(0, lastCount);
                        if (canPlay(sub)) candidates.push(sub);
                    }
                });
            }
        } else if (lastType.type === 'stairs') {
            getStairsInHand(hand).forEach(s => { if (s.length === lastCount && canPlay(s)) candidates.push(s); });
        }
    }

    // ★ 反則上がりの回避・諦めロジック ★
    // カテゴリー分類: 1(通常上がり) < 2(通常出し) < 3(出すと手札が反則上がりカードのみ残る) < 4(反則上がり)
    const getCategory = (cand) => {
        if (cand.length === hand.length) {
            return isFoulWin(cand, State.isRevolution) ? 4 : 1;
        } else {
            const rem = hand.filter(c => !cand.includes(c));
            const onlyFoul = rem.every(c => {
                if (c.number === 0) return true;
                if (c.number === 8) return true;
                if (State.isRevolution) {
                    return c.number === 3;
                } else {
                    return c.number === 2 || (c.number === 3 && c.suit === 'spade');
                }
            });
            return onlyFoul ? 3 : 2;
        }
    };

    if (State.lastPlayedCards.length === 0) {
        // 場が空の場合は、「複数枚（枚数が多い）」かつ「弱いカード」から優先して出すようにソート
        candidates.sort((a, b) => {
            const catA = getCategory(a);
            const catB = getCategory(b);
            if (catA !== catB) return catA - catB;

            if (a.length !== b.length) {
                return b.length - a.length; // 枚数が多い順（ペアや階段を優先）
            }
            return getMaxPower(a, State.isRevolution) - getMaxPower(b, State.isRevolution); // 同じ枚数なら弱い順
        });
    } else {
        // 場にカードがある場合は、単に「弱いカード」から優先して返す
        candidates.sort((a, b) => {
            const catA = getCategory(a);
            const catB = getCategory(b);
            if (catA !== catB) return catA - catB;

            return getMaxPower(a, State.isRevolution) - getMaxPower(b, State.isRevolution);
        });
    }

    return candidates;
}

function groupByNumber(hand) {
    const g = {};
    hand.forEach(c => { if (!g[c.number]) g[c.number] = []; g[c.number].push(c); });
    return g;
}

function getStairsInHand(hand) {
    const res = [];
    const suits = {};
    hand.filter(c => c.number !== 0).forEach(c => { if (!suits[c.suit]) suits[c.suit] = []; suits[c.suit].push(c); });
    Object.values(suits).forEach(sCards => {
        sCards.sort((a, b) => getCardPower(a.number, false) - getCardPower(b.number, false));
        for (let i = 0; i < sCards.length; i++) {
            for (let len = 3; len <= sCards.length - i; len++) {
                const sub = sCards.slice(i, i + len);
                if (isSequential(sub)) res.push(sub);
            }
        }
    });
    return res;
}

function isSequential(cards) {
    const ps = cards.map(c => getCardPower(c.number, false));
    for (let i = 0; i < ps.length - 1; i++) if (ps[i + 1] !== ps[i] + 1) return false;
    return true;
}

// === UI表示 ===

function render() {
    const curIdx = State.currentTurn;

    for (let i = 1; i <= 4; i++) {
        const p = State.players[i];
        const el = document.getElementById(`cpu-cards-${i}`);
        el.innerText = p.rank ? (p.isFoul ? '反則' : p.rankName) : `${p.hand.length}枚`;

        // ランク表示の更新
        const rankEl = document.querySelector(`#cpu-${i} .cpu-rank`);
        if (rankEl) {
            if (p.rank) {
                rankEl.innerText = p.isFoul ? '反則' : p.rankName;
            } else if (p.lastRank) {
                rankEl.innerText = getRankName(p.lastRank);
            } else {
                rankEl.innerText = '';
            }
        }

        const container = document.getElementById(`cpu-${i}`);

        // ターンハイライト
        if (curIdx === i && !p.rank && !p.passed) container.classList.add('active-turn');
        else container.classList.remove('active-turn');

        if (p.passed) container.classList.add('passed-cpu'); else container.classList.remove('passed-cpu');
    }

    const handContainer = document.getElementById('player-hand');
    handContainer.innerHTML = '';
    const player = State.players[0];
    const playerArea = document.getElementById('player-area');

    // プレイヤーのターンハイライト
    if (!State.isExchangePhase && curIdx === 0 && !player.rank && !player.passed) playerArea.classList.add('active-turn');
    else if (State.isExchangePhase && (player.lastRank === 1 || player.lastRank === 2)) playerArea.classList.add('active-turn');
    else playerArea.classList.remove('active-turn');

    if (player.rank) {
        document.getElementById('player-rank').innerText = player.rankName + (player.isFoul ? ' (反則)' : '');
        handContainer.innerText = player.isFoul ? '反則上がりで負けました' : '上がりました';
    } else {
        if (player.lastRank) {
            document.getElementById('player-rank').innerText = getRankName(player.lastRank);
        } else {
            document.getElementById('player-rank').innerText = '';
        }
        document.getElementById('player-pass-status').innerText = player.passed ? 'パス中' : '';
        player.hand.forEach(card => {
            const isMyTurn = (!State.isExchangePhase && curIdx === 0 && !player.passed) ||
                (State.isExchangePhase && (player.lastRank === 1 || player.lastRank === 2));
            const el = document.createElement('div');
            el.className = `card ${card.suit}`;
            el.dataset.suit = getSuitSymbol(card.suit);
            el.dataset.number = getDisplayNumber(card.number);
            el.dataset.id = card.id;
            if (isMyTurn) el.addEventListener('click', () => { el.classList.toggle('selected'); updatePlayButtonState(); });
            if (State.isExchangePhase && State.exchangeSelectedIds && State.exchangeSelectedIds.includes(card.id)) el.classList.add('selected');
            handContainer.appendChild(el);
        });
        // 動的な重なり調整を実行
        adjustHandLayout();
    }

    const tableContainer = document.getElementById('table-cards');
    tableContainer.innerHTML = '';
    State.table.forEach(card => {
        const el = document.createElement('div');
        el.className = `card ${card.suit}`;
        el.dataset.suit = getSuitSymbol(card.suit);
        el.dataset.number = getDisplayNumber(card.number);
        tableContainer.appendChild(el);
    });

    const ind = document.getElementById('turn-indicator');
    if (!State.isExchangePhase) {
        const p = State.players[curIdx];
        if (p) ind.innerText = (p.rank || p.passed) ? "..." : `${p.name} のターン`;
    }
    if (State.isRevolution) document.getElementById('revolution-badge').classList.remove('hidden');
    else document.getElementById('revolution-badge').classList.add('hidden');

    updatePlayButtonState();
}

function getSuitSymbol(s) {
    return { spade: '♠', heart: '♥', diamond: '♦', club: '♣', joker: '🃏' }[s] || '';
}

function updatePlayButtonState() {
    const playBtn = document.getElementById('btn-play');
    const passBtn = document.getElementById('btn-pass');
    const exchangeBtn = document.getElementById('btn-exchange');

    if (State.isExchangePhase) {
        playBtn.classList.add('hidden');
        passBtn.classList.add('hidden');
        exchangeBtn.classList.remove('hidden');

        const p = State.players[0];
        if (p.lastRank === 1 || p.lastRank === 2) {
            const selectedIds = Array.from(document.querySelectorAll('#player-hand .card.selected')).map(el => el.dataset.id);
            exchangeBtn.disabled = selectedIds.length !== State.exchangeCount;
        } else {
            exchangeBtn.disabled = true;
        }
        return;
    }

    playBtn.classList.remove('hidden');
    passBtn.classList.remove('hidden');
    exchangeBtn.classList.add('hidden');

    if (State.currentTurn !== 0 || State.players[0].passed || State.players[0].rank) {
        playBtn.disabled = true; passBtn.disabled = true; return;
    }
    passBtn.disabled = false;
    const selectedIds = Array.from(document.querySelectorAll('#player-hand .card.selected')).map(el => el.dataset.id);
    const selectedCards = State.players[0].hand.filter(c => selectedIds.includes(c.id));
    playBtn.disabled = !canPlay(selectedCards);
}

function endGame() {
    const modal = document.getElementById('modal-overlay');
    const sorted = [...State.players].sort((a, b) => a.rank - b.rank);
    let html = "<ul>";
    sorted.forEach(p => {
        const foulText = p.isFoul ? ' (反則)' : '';
        html += `<li>${p.rank}位: ${p.rankName}${foulText} (${p.name})</li>`;
    });
    html += "</ul>";
    document.getElementById('modal-body').innerHTML = html;
    modal.classList.remove('hidden');
    const nextBtn = document.getElementById('btn-next-game');
    nextBtn.classList.remove('hidden');
    nextBtn.onclick = () => { State.gameCount++; initGame(); };
}

// === 動的なレイアウト調整 ===
function adjustHandLayout() {
    const container = document.getElementById('player-hand');
    const cards = container.querySelectorAll('.card');
    if (cards.length <= 1) return;

    // マージンをリセット
    cards.forEach(c => c.style.marginLeft = '');

    // 現在のコンテナ幅を取得
    const containerWidth = container.clientWidth - 20; // パディング考慮
    const cardWidth = cards[0].offsetWidth;
    const totalNaturalWidth = cardWidth * cards.length;

    // 枠に収まらない場合のみ重なりを計算
    if (totalNaturalWidth > containerWidth) {
        const overlap = (totalNaturalWidth - containerWidth) / (cards.length - 1);
        for (let i = 1; i < cards.length; i++) {
            cards[i].style.marginLeft = `-${overlap}px`;
        }
    }
}

// ウィンドウリサイズ時にレイアウトを更新
window.addEventListener('resize', render);

document.getElementById('btn-play').addEventListener('click', playSelectedCards);
document.getElementById('btn-pass').addEventListener('click', handlePass);
document.getElementById('btn-exchange').addEventListener('click', executeExchange);
document.addEventListener('DOMContentLoaded', () => { initGame(); });
