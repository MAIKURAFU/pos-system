const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));

// システムロック初期状態（起動時はロック状態）
let isLocked = true;

// 従業員キーリスト（ロック解除用）
const EMPLOYEE_KEYS = ['従0001', '従0002', '従0003'];

// 会員データ（初期データ: nameを削除）
let members = [
  { id: '1001', chips: 150, history: [] },
  { id: '1002', chips: 300, history: [] },
  { id: '1003', chips: 50, history: [] }
];

// 景品（商品）データ
let products = [
  { id: 'p1', name: 'ポテトチップス', category: 'お菓子', price: 10, currentStock: 20, initialStock: 20, reductionRate: 0 },
  { id: 'p2', name: '缶コーラ', category: 'ドリンク', price: 15, currentStock: 15, initialStock: 15, reductionRate: 0 },
  { id: 'p3', name: 'ミニカー', category: 'おもちゃ', price: 50, currentStock: 5, initialStock: 5, reductionRate: 0 },
  { id: 'p4', name: 'ぬいぐるみ', category: 'イベント景品', price: 100, currentStock: 2, initialStock: 2, reductionRate: 0 }
];

// 現在選択中の会員ID
let currentMemberId = null;

// 数字のみかどうかを判定するヘルパー関数
function isNumeric(val) {
  return /^\d+$/.test(val);
}

// 会員取得または自動生成を行う関数（数字のみなら全承認、名前なし）
function getOrCreateMember(code) {
  let member = members.find(m => m.id === code);
  // 数字のみのコードで未登録の場合は動的に新規会員を生成
  if (!member && isNumeric(code)) {
    member = {
      id: code,
      chips: 0,
      history: []
    };
    members.push(member);
  }
  return member;
}

// 日本標準時（JST）の時刻文字列（HH:MM）を取得するヘルパー関数
function getJSTTimeString() {
  return new Date().toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

io.on('connection', (socket) => {
  // 初回接続時にデータを送信
  const currentMember = members.find(m => m.id === currentMemberId) || null;
  socket.emit('init-data', {
    products,
    isLocked,
    member: currentMember
  });

  // 初期ロック状態を通知
  socket.emit('system-lock-status', {
    isLocked,
    message: isLocked ? 'システムはロックされています' : 'システムは解除されています'
  });

  // 【iPhone / iPad】QRコードスキャン処理
  socket.on('scan-qr', (data) => {
    if (!data || !data.code) return;
    const code = data.code.trim();

    // 従業員QRコードの場合 -> ロック解除
    if (EMPLOYEE_KEYS.includes(code)) {
      isLocked = false;
      io.emit('system-lock-status', {
        isLocked: false,
        message: `ロックを解除しました (担当: ${code})`
      });
      io.emit('data-updated', {
        member: members.find(m => m.id === currentMemberId) || null,
        products
      });
      return;
    }

    // ロック中に会員QRコードが読み込まれた場合
    if (isLocked) {
      socket.emit('error-message', { message: 'システムがロックされています。従業員QRコードで解除してください。' });
      return;
    }

    // 数字のみのQRコードであれば全て会員として処理（マスターに無ければ自動生成）
    const member = getOrCreateMember(code);
    if (member) {
      currentMemberId = member.id;
      io.emit('member-scanned', { member });
    } else {
      socket.emit('error-message', { message: '無効なQRコード形式です（数字のみのコードを指定してください）' });
    }
  });

  // 【手動操作】システムロックボタンが押されたとき
  socket.on('lock-system', () => {
    isLocked = true;
    currentMemberId = null; // 選択中の会員をリセット
    io.emit('system-lock-status', {
      isLocked: true,
      message: 'システムがロックされました'
    });
    io.emit('data-updated', { member: null, products });
  });

  // 【member_check.html 専用】残高照会（数字のみなら全て可、他端末へは非通知）
  socket.on('check-member-balance', (data) => {
    if (!data || !data.code) return;
    const code = data.code.trim();

    const member = getOrCreateMember(code);
    if (member) {
      socket.emit('member-balance-result', { success: true, member });
    } else {
      socket.emit('member-balance-result', { success: false, message: '無効なQRコード形式です' });
    }
  });

  // チップチャージ処理
  socket.on('charge-chips', (data) => {
    if (isLocked) return socket.emit('error-message', { message: 'システムがロックされています' });
    const member = members.find(m => m.id === data.memberId);
    if (member) {
      member.chips += data.amount;
      io.emit('member-updated', { member });
    }
  });

  // 景品交換（購入）処理
  socket.on('purchase-items', (data) => {
    if (isLocked) return socket.emit('error-message', { message: 'システムがロックされています' });

    const member = members.find(m => m.id === data.memberId);
    if (!member) return socket.emit('error-message', { message: '会員情報が見つかりません' });

    let totalCost = 0;
    const itemSummary = [];

    for (const item of data.cartItems) {
      const prod = products.find(p => p.id === item.id);
      if (!prod || prod.currentStock < item.quantity) {
        return socket.emit('error-message', { message: `${prod ? prod.name : '商品'}の在庫が足りません` });
      }
      totalCost += prod.price * item.quantity;
      itemSummary.push(`${prod.name} × ${item.quantity}`);
    }

    if (member.chips < totalCost) {
      return socket.emit('error-message', { message: 'チップ数が不足しています' });
    }

    member.chips -= totalCost;
    data.cartItems.forEach(item => {
      const prod = products.find(p => p.id === item.id);
      if (prod) {
        prod.currentStock -= item.quantity;
        prod.reductionRate = Math.round(((prod.initialStock - prod.currentStock) / prod.initialStock) * 100);
      }
    });

    // 日本標準時（JST）で時刻を記録
    const timeStr = getJSTTimeString();

    member.history.unshift({
      time: timeStr,
      items: itemSummary.join(', '),
      cost: totalCost,
      staffId: data.staffId || null
    });

    currentMemberId = null;

    socket.emit('purchase-success', { message: '交換が完了しました' });
    io.emit('data-updated', { member: null, products });
  });

  // 在庫補充
  socket.on('restock-item', (data) => {
    const prod = products.find(p => p.id === data.productId);
    if (prod) {
      prod.currentStock += data.amount;
      if (prod.currentStock > prod.initialStock) {
        prod.initialStock = prod.currentStock;
      }
      prod.reductionRate = Math.round(((prod.initialStock - prod.currentStock) / prod.initialStock) * 100);
      io.emit('data-updated', { member: members.find(m => m.id === currentMemberId) || null, products });
    }
  });

  // 商品情報更新
  socket.on('update-product', (data) => {
    const prod = products.find(p => p.id === data.productId);
    if (prod) {
      prod.name = data.name;
      prod.price = data.price;
      prod.currentStock = data.currentStock;
      if (prod.currentStock > prod.initialStock) prod.initialStock = prod.currentStock;
      prod.reductionRate = Math.round(((prod.initialStock - prod.currentStock) / prod.initialStock) * 100);
      io.emit('data-updated', { member: members.find(m => m.id === currentMemberId) || null, products });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});