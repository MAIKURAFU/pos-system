const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));

// ルーティング設定
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ipad.html'));
});

app.get('/iphone', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'iphone.html'));
});

// メモリ内データストア
let isLocked = true; // 起動時はデフォルトでロック状態
let currentEmployeeId = null; // ★現在ロック解除中の担当従業員ID

// 初期景品データ
let products = [
  { id: 'p1', name: 'うまい棒セット', category: 'お菓子', price: 10, initialStock: 100, currentStock: 80, reductionRate: 20 },
  { id: 'p2', name: '高級チョコBOX', category: 'お菓子', price: 50, initialStock: 30, currentStock: 15, reductionRate: 50 },
  { id: 'p3', name: '緑茶ペットボトル', category: 'ドリンク', price: 15, initialStock: 50, currentStock: 40, reductionRate: 20 },
  { id: 'p4', name: 'エナジードリンク', category: 'ドリンク', price: 25, initialStock: 40, currentStock: 10, reductionRate: 75 },
  { id: 'p5', name: 'RCカー', category: 'おもちゃ', price: 300, initialStock: 5, currentStock: 2, reductionRate: 60 },
  { id: 'p6', name: '限定フィギュア', category: 'イベント景品', price: 500, initialStock: 3, currentStock: 1, reductionRate: 67 }
];

// 会員データ
let members = {};

// 従業員IDリスト
const EMPLOYEE_KEYS = ['従0001', '従0002', '従0003'];

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

io.on('connection', (socket) => {
  console.log('クライアントが接続しました:', socket.id);

  socket.emit('init-data', {
    products,
    isLocked,
    currentEmployeeId
  });

  // QRコードスキャンイベント
  socket.on('scan-qr', (data) => {
    const rawCode = data && data.code ? data.code.trim() : '';
    if (!rawCode) return;

    // 1. 従業員キーによるロック解除処理
    if (EMPLOYEE_KEYS.includes(rawCode)) {
      if (!isLocked) {
        socket.emit('toast-message', { message: `すでに解除されています (担当: ${currentEmployeeId})` });
        return;
      }

      isLocked = false;
      currentEmployeeId = rawCode; // ★解除した従業員IDを記録
      console.log(`[従業員操作] ${rawCode} によりシステムが解除されました`);

      io.emit('system-lock-status', {
        isLocked: false,
        employeeId: currentEmployeeId,
        message: `従業員キー (${rawCode}) によりシステムが解除されました`
      });
      return;
    }

    // 2. ロック中ガード
    if (isLocked) {
      socket.emit('error-message', { message: 'システムはロックされています。従業員キーで解除してください。' });
      return;
    }

    // 3. 会員処理
    let memberId = rawCode;
    if (!isNaN(rawCode) && rawCode.length <= 4) {
      memberId = rawCode.padStart(4, '0');
    }

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
    io.emit('member-scanned', { member });
  });

  // チップチャージ処理
  socket.on('charge-chips', ({ memberId, amount }) => {
    if (isLocked) return socket.emit('error-message', { message: 'ロック中のため操作できません' });
    if (!members[memberId]) return socket.emit('error-message', { message: '会員が見つかりません' });

    const numAmount = parseInt(amount, 10);
    if (isNaN(numAmount) || numAmount <= 0) return;

    members[memberId].chips += numAmount;

    // ★チャージ履歴を保存（担当者ID付き）
    const now = new Date();
    const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    members[memberId].history.unshift({
      time: timeStr,
      type: 'チャージ',
      items: `チップチャージ (+${numAmount}枚)`,
      cost: `+${numAmount}`,
      employeeId: currentEmployeeId || '不明' // ★担当者IDを付与
    });

    console.log(`[チャージ] ID: ${memberId}, +${numAmount}枚 (担当: ${currentEmployeeId})`);

    io.emit('member-updated', { member: members[memberId] });
    socket.emit('toast-message', { message: `${numAmount} 枚のチップをチャージしました` });
  });

  // 景品交換（購入）処理
  socket.on('purchase-items', ({ memberId, cartItems }) => {
    if (isLocked) return socket.emit('error-message', { message: 'ロック中のため操作できません' });
    const member = members[memberId];
    if (!member) return socket.emit('error-message', { message: '会員が見つかりません' });

    let totalCost = 0;
    const itemsToDeduct = [];

    for (const item of cartItems) {
      const prod = products.find(p => p.id === item.id);
      if (!prod) return socket.emit('error-message', { message: '存在しない商品が含まれています' });
      if (prod.currentStock < item.quantity) {
        return socket.emit('error-message', { message: `「${prod.name}」の在庫が不足しています` });
      }
      totalCost += prod.price * item.quantity;
      itemsToDeduct.push({ product: prod, quantity: item.quantity });
    }

    if (member.chips < totalCost) {
      return socket.emit('error-message', { message: `チップが不足しています (必要: ${totalCost}枚 / 所持: ${member.chips}枚)` });
    }

    member.chips -= totalCost;
    
    const summaryNames = [];
    itemsToDeduct.forEach(({ product, quantity }) => {
      product.currentStock -= quantity;
      summaryNames.push(`${product.name}×${quantity}`);
    });

    recalculateReductionRates();

    // ★景品交換履歴を保存（担当者ID付き）
    const now = new Date();
    const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    
    member.history.unshift({
      time: timeStr,
      type: '交換',
      items: summaryNames.join(', '),
      cost: `-${totalCost}`,
      employeeId: currentEmployeeId || '不明' // ★担当者IDを付与
    });

    console.log(`[景品交換完了] ID: ${memberId}, 消費: ${totalCost} (担当: ${currentEmployeeId})`);

    socket.emit('purchase-success', { message: '交換が完了しました！' });
    io.emit('data-updated', {
      member: member,
      products: products
    });
  });

  // 手動システムロック
  socket.on('lock-system', () => {
    isLocked = true;
    currentEmployeeId = null; // ★ロック時に担当者情報を初期化
    console.log('[手動ロック] システムが手動でロックされました');
    io.emit('system-lock-status', {
      isLocked: true,
      employeeId: null,
      message: 'システムが手動でロックされました'
    });
  });

  socket.on('disconnect', () => {
    console.log('クライアントが切断しました:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================`);
  console.log(` レジ管理サーバーが起動しました`);
  console.log(` Port: ${PORT}`);
  console.log(`=================================`);
});