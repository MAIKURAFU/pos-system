const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------
// メモリ内データストア（永続化が必要な場合は DB/JSON ファイル等へ変更）
// ---------------------------------------------------------
let isLocked = true; // 起動時はデフォルトでロック状態

// 初期景品データ
let products = [
  { id: 'p1', name: 'うまい棒セット', category: 'お菓子', price: 10, initialStock: 100, currentStock: 80, reductionRate: 20 },
  { id: 'p2', name: '高級チョコBOX', category: 'お菓子', price: 50, initialStock: 30, currentStock: 15, reductionRate: 50 },
  { id: 'p3', name: '緑茶ペットボトル', category: 'ドリンク', price: 15, initialStock: 50, currentStock: 40, reductionRate: 20 },
  { id: 'p4', name: 'エナジードリンク', category: 'ドリンク', price: 25, initialStock: 40, currentStock: 10, reductionRate: 75 },
  { id: 'p5', name: 'RCカー', category: 'おもちゃ', price: 300, initialStock: 5, currentStock: 2, reductionRate: 60 },
  { id: 'p6', name: '限定フィギュア', category: 'イベント景品', price: 500, initialStock: 3, currentStock: 1, reductionRate: 67 }
];

// 会員データ（ID: 会員オブジェクト）
let members = {};

// 従業員IDリスト（システムロック/解除用キー）
const EMPLOYEE_KEYS = ['従0001', '従0002', '従0003'];

// 減少率の再計算関数
function recalculateReductionRates() {
  products.forEach(p => {
    if (p.initialStock > 0) {
      const rate = ((p.initialStock - p.currentStock) / p.initialStock) * 100;
      p.reductionRate = Math.round(rate);
    } else {
      p.reductionRate = 0;
    }
  });
}

// ---------------------------------------------------------
// Socket.IO 通信イベント定義
// ---------------------------------------------------------
io.on('connection', (socket) => {
  console.log('クライアントが接続しました:', socket.id);

  // 初期データ送信
  socket.emit('init-data', {
    products,
    isLocked
  });

  // -------------------------------------------------------
  // QRコードスキャンイベント (iPhoneスキャナーから送信)
  // -------------------------------------------------------
  socket.on('scan-qr', (data) => {
    const rawCode = data && data.code ? data.code.trim() : '';
    if (!rawCode) return;

    // 1. 従業員キー（従0001, 従0002, 従0003）の判定（解除専用処理）
    if (EMPLOYEE_KEYS.includes(rawCode)) {
      if (!isLocked) {
        // すでに解除されている場合
        socket.emit('toast-message', { message: 'システムはすでに解除されています' });
        return;
      }

      // ロック解除処理を実行
      isLocked = false;
      console.log(`[従業員操作] ${rawCode} によりシステムが解除されました`);

      io.emit('system-lock-status', {
        isLocked: false,
        message: `従業員キー (${rawCode}) によりシステムが解除されました`
      });
      return;
    }

    // 2. ロック中は会員処理を行わない
    if (isLocked) {
      socket.emit('error-message', { message: 'システムはロックされています。従業員キーで解除してください。' });
      return;
    }

    // 3. 従0001〜従0003 以外のすべてのコードを「会員コード」として処理
    let memberId = rawCode;

    // 数字のみで入力・読み取られた場合（例: "1" -> "0001" に4桁パディング）
    if (!isNaN(rawCode) && rawCode.length <= 4) {
      memberId = rawCode.padStart(4, '0');
    }

    // 会員データが存在しない場合は自動作成
    if (!members[memberId]) {
      members[memberId] = {
        id: memberId,
        name: `会員 ${memberId}`,
        chips: 0,
        history: []
      };
      console.log(`[新規会員登録] ID: ${memberId}`);
    }

    const member = members[memberId];
    console.log(`[会員スキャン] ID: ${member.id}, 所持チップ: ${member.chips}`);

    // iPad側に会員データを通知
    io.emit('member-scanned', { member });
  });

  // -------------------------------------------------------
  // チップチャージ処理
  // -------------------------------------------------------
  socket.on('charge-chips', ({ memberId, amount }) => {
    if (isLocked) return socket.emit('error-message', { message: 'ロック中のため操作できません' });
    if (!members[memberId]) return socket.emit('error-message', { message: '会員が見つかりません' });

    const numAmount = parseInt(amount, 10);
    if (isNaN(numAmount) || numAmount <= 0) return;

    members[memberId].chips += numAmount;
    console.log(`[チャージ] ID: ${memberId}, +${numAmount}枚 (合計: ${members[memberId].chips}枚)`);

    io.emit('member-updated', { member: members[memberId] });
    socket.emit('toast-message', { message: `${numAmount} 枚のチップをチャージしました` });
  });

  // -------------------------------------------------------
  // 景品交換（購入）処理
  // -------------------------------------------------------
  socket.on('purchase-items', ({ memberId, cartItems }) => {
    if (isLocked) return socket.emit('error-message', { message: 'ロック中のため操作できません' });
    const member = members[memberId];
    if (!member) return socket.emit('error-message', { message: '会員が見つかりません' });

    // バリデーション & 合計金額と在庫チェック
    let totalCost = 0;
    const itemsToDeduct = [];

    for (const item of cartItems) {
      const prod = products.find(p => p.id === item.id);
      if (!prod) {
        return socket.emit('error-message', { message: '存在しない商品が含まれています' });
      }
      if (prod.currentStock < item.quantity) {
        return socket.emit('error-message', { message: `「${prod.name}」の在庫が不足しています` });
      }
      totalCost += prod.price * item.quantity;
      itemsToDeduct.push({ product: prod, quantity: item.quantity });
    }

    // 所持チップの確認
    if (member.chips < totalCost) {
      return socket.emit('error-message', { message: `チップが不足しています (必要: ${totalCost}枚 / 所持: ${member.chips}枚)` });
    }

    // 処理実行（チップ引き落とし & 在庫減算）
    member.chips -= totalCost;
    
    const summaryNames = [];
    itemsToDeduct.forEach(({ product, quantity }) => {
      product.currentStock -= quantity;
      summaryNames.push(`${product.name}×${quantity}`);
    });

    // 減少率再計算
    recalculateReductionRates();

    // 履歴追加 (最新が先頭)
    const now = new Date();
    const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    
    member.history.unshift({
      time: timeStr,
      items: summaryNames.join(', '),
      cost: totalCost
    });

    console.log(`[景品交換完了] ID: ${memberId}, 消費チップ: ${totalCost}`);

    // クライアントへ成功通知および全体更新
    socket.emit('purchase-success', { message: '交換が完了しました！' });
    io.emit('data-updated', {
      member: member,
      products: products
    });
  });

  // -------------------------------------------------------
  // 在庫追加・補充処理
  // -------------------------------------------------------
  socket.on('restock-item', ({ productId, amount }) => {
    const prod = products.find(p => p.id === productId);
    if (!prod) return;

    const numAmount = parseInt(amount, 10);
    if (isNaN(numAmount) || numAmount <= 0) return;

    prod.currentStock += numAmount;
    prod.initialStock += numAmount; // 初期在庫（基準値）も加算
    recalculateReductionRates();

    console.log(`[在庫補充] ${prod.name}: +${numAmount} (現在在庫: ${prod.currentStock})`);

    io.emit('data-updated', { products });
    socket.emit('toast-message', { message: `「${prod.name}」に ${numAmount} 個補充しました` });
  });

  // -------------------------------------------------------
  // 商品情報個別編集
  // -------------------------------------------------------
  socket.on('update-product', ({ productId, name, price, currentStock }) => {
    const prod = products.find(p => p.id === productId);
    if (!prod) return;

    prod.name = name;
    prod.price = parseInt(price, 10) || prod.price;
    prod.currentStock = parseInt(currentStock, 10) || 0;
    if (prod.currentStock > prod.initialStock) {
      prod.initialStock = prod.currentStock;
    }
    recalculateReductionRates();

    console.log(`[商品編集] ID: ${productId}, 名前: ${name}, 価格: ${price}, 在庫: ${currentStock}`);

    io.emit('data-updated', { products });
    socket.emit('toast-message', { message: '景品情報を更新しました' });
  });

  // -------------------------------------------------------
  // iPad側からの直接ロック要請（ボタン押下）
  // -------------------------------------------------------
  socket.on('lock-system', () => {
    isLocked = true;
    console.log('[手動ロック] システムが手動でロックされました');
    io.emit('system-lock-status', {
      isLocked: true,
      message: 'システムが手動でロックされました'
    });
  });

  socket.on('disconnect', () => {
    console.log('クライアントが切断しました:', socket.id);
  });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(` レジ管理サーバーが起動しました`);
  console.log(` http://localhost:${PORT}`);
  console.log(`=================================`);
});