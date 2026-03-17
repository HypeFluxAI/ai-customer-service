// Bulk import KnowledgeBase + QnA to production MongoDB
// Run: node import_kb.js
const { MongoClient } = require('mongodb')

const MONGO_URI = 'mongodb://122.99.183.50:31017/deeplinkgame'

const kbEntries = [
  {
    language: 'ko',
    title: '임대 불가 상태',
    keywords: ['임대불가','임대 불가','임대가능','대여불가','대기','여유기기','이용가능','이용불가','접속대기','만석','기기없','자리없','빈자리','대기시간','PC없','피씨없','모두임대','기기부족'],
    contentHtml: '임대 가능으로 표시되어 있어도 다른 분이 먼저 임대하시면 임대 불가로 바뀔 수 있어요. 현재 기기 이용률이 높아서 기기가 금방 나가는 편입니다. 저녁 11시 이후, 새벽 및 오전 시간대에 비교적 여유 기기가 있으니 참고해주세요. 계속 기기를 늘리고 있습니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '게임 끊김/렉',
    keywords: ['끊김','렉','끊겨','랙','지연','느려','프리징','멈춤'],
    contentHtml: '게임 중 끊김 현상은 주로 인터넷 환경(와이파이/유선) 이슈인 경우가 많습니다. 확인을 위해 계정 아이디(로고 아래 10자리 숫자)와 임대하신 기기 번호를 알려주시면 점검해드리겠습니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: 'PC방 혜택',
    keywords: ['혜택','피방','PC방','pc방','넥슨','던파','던전앤파이터','리니지','리클','픽시','깃털','가맹','엔씨'],
    contentHtml: 'DeepLink PC방 기기를 임대하시면 넥슨 게임(던파 등) 및 리니지 클래식 등 PC방 혜택이 모두 적용됩니다. 엔씨소프트 공식 가맹 PC방이며, 제재 걱정 없이 안심하고 이용하실 수 있습니다. 단, 반드시 PC방 기기로 임대하셔야 혜택이 적용됩니다(일반PC는 혜택 없음).',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '2클라이언트',
    keywords: ['2클','2클라','두클','멀티','다중실행','동시'],
    contentHtml: '한 기기에서 2클라이언트(동시에 2개 게임 실행)는 불가능합니다. 2클라를 하시려면 기기를 두 대 임대하셔야 합니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '포인트 충전 방법',
    keywords: ['충전','결제','포인트','계좌','이체','카드','입금','카카오'],
    contentHtml: '포인트 충전은 카드결제와 계좌이체(카카오뱅크) 두 가지 방법이 있습니다. 카드결제는 앱에서 바로 가능합니다. 계좌이체를 원하시면 상담원에게 말씀해주시면 계좌번호를 안내해드립니다. 입금 후 입금자명과 계정 아이디(로고 아래 10자리 숫자)를 알려주시면 충전 처리해드립니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '임대 시간 종료',
    keywords: ['시간','종료','만료','끝나면','재부팅','저장','연장'],
    contentHtml: '임대 시간이 종료되면 PC가 자동으로 재부팅됩니다. 실행 중이던 게임은 모두 종료되며, 게임 데이터는 서버에 저장된 것만 유지됩니다. 시간이 끝나기 전에 게임을 저장하시거나, 미리 시간을 연장하시는 것을 권장합니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '계정 로그인 변경',
    keywords: ['계정','로그인','로그아웃','변경','여러','전환','주문서'],
    contentHtml: '임대 기간 동안 여러 계정으로 로그인/로그아웃을 자유롭게 하실 수 있습니다. 계정 변경 횟수에 제한은 없습니다. 단, 2클라이언트(동시 2개 계정)는 불가하며 한 번에 한 계정만 사용 가능합니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '해외 이용',
    keywords: ['해외','vpn','VPN','외국','거리'],
    contentHtml: '해외에서도 VPN을 이용하여 접속하시면 사용 가능합니다. 다만 서버와의 물리적 거리로 인해 지연(렉)이 발생할 수 있습니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '일반PC와 PC방 차이',
    keywords: ['일반','일반PC','일반피씨','차이','고사양'],
    contentHtml: 'PC방 기기는 PC방 혜택(넥슨, 리니지 클래식 등)이 적용되는 기기입니다. 일반PC는 PC방 혜택 없이 고사양 PC를 임대하는 서비스이며, 아직 출시 전입니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: 'Wallet Not Login 오류',
    keywords: ['wallet','로그인','not login','오류','에러','연결'],
    contentHtml: 'Wallet Not Login 오류는 PC가 켜져 있어도 DeepLink 프로그램이 정상 실행되지 않았을 때 발생합니다. 최신 버전(1.1.0.49) 사용 여부를 확인해주시고, 문제가 계속되면 계정 아이디와 화면 캡쳐를 보내주시면 확인해드리겠습니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '포인트 환불',
    keywords: ['환불','돌려','취소','반환'],
    contentHtml: '임대 중 기기 문제(렉, 끊김 등)로 정상 이용이 불가능했던 경우 포인트 환불이 가능할 수 있습니다. 확인을 위해 계정 아이디(로고 아래 10자리 숫자)를 알려주시면 상담원이 확인 후 처리해드리겠습니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '모바일 접속',
    keywords: ['모바일','핸드폰','스마트폰','앱','아이폰','안드로이드'],
    contentHtml: 'DeepLink 앱을 다운받으시면 모바일에서도 원격으로 PC를 임대하여 게임하실 수 있습니다. 다만 화면이 작아서 PC나 태블릿에 비해 조작이 불편할 수 있습니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    language: 'ko',
    title: '연결 안됨/접속 오류',
    keywords: ['연결','접속','안됨','안돼','화면','로딩','연결중'],
    contentHtml: '연결이 안 되거나 화면이 나오지 않는 경우, 먼저 브라우저를 새로고침(F5)하거나 다시 접속해보세요. 그래도 안 되면 계정 아이디(로고 아래 10자리 숫자)와 사용 환경(브라우저, 와이파이/유선)을 알려주시면 확인해드리겠습니다.',
    isActive: true, createdAt: new Date(), updatedAt: new Date()
  }
]

const qnaEntries = [
  {
    question: { ko: 'PC방 혜택이 적용되나요?', zh: '有网吧优惠吗？', en: 'Do PC bang benefits apply?' },
    answer: { ko: '네, DeepLink PC방 기기를 임대하시면 넥슨(던파 등), 리니지 클래식 등 PC방 혜택이 모두 적용됩니다.', zh: '是的，租用DeepLink网吧机器可以享受Nexon（DNF等）、天堂经典等网吧优惠。', en: 'Yes, renting a DeepLink PC bang machine gives you all PC bang benefits for Nexon games (DNF etc.), Lineage Classic, etc.' },
    order: 1, isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    question: { ko: '2클라이언트 가능한가요?', zh: '可以双开吗？', en: 'Can I run 2 clients?' },
    answer: { ko: '2클라는 불가합니다. 기기 두 대를 임대하셔야 합니다.', zh: '不支持双开，需要租用两台机器。', en: '2 clients are not possible. You need to rent two machines.' },
    order: 2, isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    question: { ko: '포인트 충전은 어떻게 하나요?', zh: '如何充值积分？', en: 'How do I charge points?' },
    answer: { ko: '카드결제(앱 내)와 계좌이체(카카오뱅크) 두 가지 방법이 있습니다. 계좌이체는 상담원에게 문의해주세요.', zh: '可以通过卡支付（应用内）或银行转账（KakaoBank）充值。转账请联系客服。', en: 'You can pay by card (in-app) or bank transfer (KakaoBank). For bank transfer, please contact support.' },
    order: 3, isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    question: { ko: '임대 시간이 끝나면 어떻게 되나요?', zh: '租赁时间到了会怎样？', en: 'What happens when rental time expires?' },
    answer: { ko: '임대 시간 종료 시 PC가 자동으로 재부팅되며, 실행 중이던 게임은 모두 종료됩니다.', zh: '租赁时间结束后PC会自动重启，运行中的游戏会全部关闭。', en: 'The PC reboots automatically and all running games are closed.' },
    order: 4, isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    question: { ko: '여러 계정으로 변경 가능한가요?', zh: '可以切换多个账号吗？', en: 'Can I switch between accounts?' },
    answer: { ko: '네, 임대 기간 동안 여러 계정으로 자유롭게 로그인/로그아웃 하실 수 있습니다. 횟수 제한 없습니다.', zh: '可以，租赁期间可以自由切换多个账号登录，没有次数限制。', en: 'Yes, you can freely login/logout with multiple accounts during rental. No limit.' },
    order: 5, isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    question: { ko: '해외에서도 이용 가능한가요?', zh: '海外可以使用吗？', en: 'Can I use it from overseas?' },
    answer: { ko: '네, VPN으로 연결하시면 해외에서도 이용 가능합니다. 다만 거리에 따라 지연이 있을 수 있습니다.', zh: '可以通过VPN连接使用，但距离远可能会有延迟。', en: 'Yes, you can connect via VPN from overseas, but there may be latency due to distance.' },
    order: 6, isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    question: { ko: '일반PC와 PC방 기기의 차이가 뭔가요?', zh: '普通PC和网吧机器有什么区别？', en: 'What is the difference between regular PC and PC bang?' },
    answer: { ko: 'PC방 기기는 PC방 혜택(게임 혜택)이 적용되는 기기이고, 일반PC는 고사양 PC입니다(아직 출시 전이에요).', zh: '网吧机器有网吧游戏优惠，普通PC是高配电脑（尚未上线）。', en: 'PC bang machines have game benefits. Regular PCs are high-spec machines (not yet available).' },
    order: 7, isActive: true, createdAt: new Date(), updatedAt: new Date()
  },
  {
    question: { ko: '모바일로도 이용 가능한가요?', zh: '可以用手机吗？', en: 'Can I use it on mobile?' },
    answer: { ko: '네, DeepLink 앱을 다운받으시면 모바일에서도 원격으로 PC를 임대하여 게임하실 수 있습니다.', zh: '可以，下载DeepLink APP即可在手机上远程租用PC玩游戏。', en: 'Yes, download the DeepLink app to rent PCs remotely from mobile.' },
    order: 8, isActive: true, createdAt: new Date(), updatedAt: new Date()
  }
]

async function main() {
  const client = await MongoClient.connect(MONGO_URI)
  const db = client.db('deeplinkgame')

  const kbResult = await db.collection('knowledge_bases').insertMany(kbEntries)
  console.log('KnowledgeBase inserted:', kbResult.insertedCount, 'entries')

  const qnaResult = await db.collection('qnas').insertMany(qnaEntries)
  console.log('QnA inserted:', qnaResult.insertedCount, 'entries')

  // Verify
  const kbCount = await db.collection('knowledge_bases').countDocuments({ isActive: true })
  const qnaCount = await db.collection('qnas').countDocuments({ isActive: true })
  console.log('\nVerify — KB active:', kbCount, '| QnA active:', qnaCount)

  await client.close()
}

main().catch(e => { console.error(e); process.exit(1) })
