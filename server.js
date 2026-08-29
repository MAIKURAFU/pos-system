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

// ヘルスチェック用エンドポイント
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// システムロック初期状態（起動時はロック状態）
let isLocked = true;

// 従業員キーリスト（ロック解除用）
const EMPLOYEE_KEYS = ['従0001', '従0002', '従0003'];

// 会員データ（初期チップはすべて0）
let members = [
];

// 景品（商品）データ（初期データは空）
let products = [];

// 現在選択中の会員ID（iPadレジ側で選択中の会員）
let currentMemberId = null;

// 数字のみかどうかを判定するヘルパー関数
function isNumeric(val) {
  return /^\d+$/.test(val);
}

// 会員取得または自動生成を行う関数
function getOrCreateMember(code) {
  let member = members.find(m => m.id === code);
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

// 日本標準時（JST）の時刻文字列（HH:MM:SS）を取得するヘルパー関数
function getJSTTimeString(includeSeconds = false) {
  const options = {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  if (includeSeconds) {
    options.second = '2-digit';
  }
  return new Date().toLocaleTimeString('ja-JP', options);
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

  // 【iPhone / iPad】QRコードスキャン処理（レジ用）
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
      socket.emit('error-message', { message: 'システムがロックされています。従業員コードで解除してください。' });
      return;
    }

    // 数字のみのQRコードであれば全て会員として処理
    const member = getOrCreateMember(code);
    if (member) {
      currentMemberId = member.id;
      
      // iPhoneから「退場 (action: 'exit')」として送られてきた場合の処理
      if (data.action === 'exit') {
        const lastLog = member.history[0];

        // 直前のログがすでに「退場」の場合は重複ログを記録しない
        if (lastLog && lastLog.items === '退場') {
          currentMemberId = null;
          return;
        }

        const timeStr = getJSTTimeString(false);

        // 会員の履歴（history）の先頭に「退場」ログを追加
        member.history.unshift({
          time: timeStr,
          items: '退場',
          cost: 0,
          staffId: null
        });

        // 退場処理後は選択中会員を解除
        currentMemberId = null;

        // 既存の退場用リアルタイム通知イベントを発行
        io.emit('member-exit-log', {
          memberId: member.id,
          time: getJSTTimeString(true),
          action: '退場'
        });

        // 全端末（iPad含む）へ更新後のデータを送信
        io.emit('data-updated', { member: null, products });

      } else {
        // 通常のスキャン・入場処理
        io.emit('member-scanned', { member });
      }
    } else {
      socket.emit('error-message', { message: '無効なQRコードです' });
    }
  });

  // 【手動操作】システムロックボタンが押されたとき
  socket.on('lock-system', () => {
    isLocked = true;
    currentMemberId = null;
    io.emit('system-lock-status', {
      isLocked: true,
      message: 'システムがロックされました'
    });
    io.emit('data-updated', { member: null, products });
  });

  // 【会員コイン確認画面用】残高照会 ＆ 入場ログ追加処理
  socket.on('check-member-balance', (data) => {
    if (!data || !data.code) return;
    const code = data.code.trim();

    const member = getOrCreateMember(code);
    if (member) {
      const lastLog = member.history[0];

      // 直前のログがすでに「入場」でない場合のみ「入場」ログを追加
      if (!lastLog || lastLog.items !== '入場') {
        const timeStr = getJSTTimeString(false);

        // 会員の履歴（history）の先頭に「入場」ログを追加
        member.history.unshift({
          time: timeStr,
          items: '入場',
          cost: 0,
          staffId: null
        });
      }

      socket.emit('member-balance-result', { success: true, member });
    } else {
      socket.emit('member-balance-result', { success: false, message: '無効なQRコードです' });
    }
  });

  // チップチャージ・増減処理（履歴へのログ追加対応版）
  socket.on('charge-chips', (data) => {
    if (isLocked) return socket.emit('error-message', { message: 'システムがロックされています' });
    const member = members.find(m => m.id === data.memberId);
    if (member) {
      const amount = parseInt(data.amount, 10) || 0;
      if (amount === 0) return;

      member.chips += amount;
      const timeStr = getJSTTimeString(false);

      // 増減内容に応じた項目名を設定（プラスならチャージ、マイナスなら調整など）
      const actionName = amount > 0 ? '+チップ' : '-チップ減額';

      member.history.unshift({
        time: timeStr,
        items: actionName,
        cost: -amount,
        staffId: data.staffId || null
      });

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
        prod.reductionRate = prod.initialStock > 0 
          ? Math.round(((prod.initialStock - prod.currentStock) / prod.initialStock) * 100)
          : 0;
      }
    });

    const timeStr = getJSTTimeString(false);

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

  // 在庫補充（未登録のJANコード読み取り時に新規登録）
  socket.on('restock-item', (data) => {
    if (!data || !data.productId) return;
    const code = data.productId.trim();
    const amount = parseInt(data.amount, 10) || 1;

    let prod = products.find(p => p.id === code);

    if (prod) {
      prod.currentStock += amount;
      if (prod.currentStock > prod.initialStock) {
        prod.initialStock = prod.currentStock;
      }
      prod.reductionRate = prod.initialStock > 0 
        ? Math.round(((prod.initialStock - prod.currentStock) / prod.initialStock) * 100) 
        : 0;
    } else {
      prod = {
        id: code,
        name: `新商品 (${code})`,
        category: '未分類',
        price: 0,
        currentStock: amount,
        initialStock: amount,
        reductionRate: 0
      };
      products.push(prod);
    }

    io.emit('data-updated', { 
      member: members.find(m => m.id === currentMemberId) || null, 
      products 
    });
  });

  // 商品情報更新
  socket.on('update-product', (data) => {
    const prod = products.find(p => p.id === data.productId);
    if (prod) {
      prod.name = data.name;
      prod.category = data.category || '未分類';
      prod.price = parseInt(data.price, 10) || 0;
      prod.currentStock = parseInt(data.currentStock, 10) || 0;
      if (prod.currentStock > prod.initialStock) prod.initialStock = prod.currentStock;
      prod.reductionRate = prod.initialStock > 0 
        ? Math.round(((prod.initialStock - prod.currentStock) / prod.initialStock) * 100) 
        : 0;
      io.emit('data-updated', { member: members.find(m => m.id === currentMemberId) || null, products });
    }
  });

  // 【追加】総合管理ダッシュボードからのデータ要求への応答処理
  socket.on('request-manage-data', () => {
    socket.emit('manage-data-response', {
      members,
      products
    });
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});