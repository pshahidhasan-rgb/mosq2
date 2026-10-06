/**
 * Soniox Real-Time Speech Translation Service
 * 
 * Implements the "Dynamic Language Gates" Audio Fan-Out Architecture:
 *  - 1 Single Audio Ingest from Imam pulpit mic over mosque Wi-Fi
 *  - Dynamic On-Demand Gates: opens 1 Soniox WebSocket stream per active language
 *  - Audio Fan-Out: duplicates PCM audio in server memory and pipes to active gates
 *  - Auto-Detects source speech (Arabic, English, dialects) by omitting source_language
 *  - Sub-200ms end-to-end token streaming to TV and mobile attendees
 *  - Auto-closes gates when attendees leave ($0 for unused languages)
 *  - High-Fidelity Word-by-Word Streaming Simulation Mode (<100ms token intervals)
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

const SONIOX_WS_ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';
const DEFAULT_MODEL = 'stt-rt-v5';
const SAMPLE_RATE = 16000;
const NUM_CHANNELS = 1;

// ---------------------------------------------------------------------------
// Realistic Friday Khutbah Sermon Corpus with Full Multi-Language Translations
// ---------------------------------------------------------------------------
const KHUTBAH_SIMULATION_CORPUS = [
  {
    arabic: 'إنَّ الحَمْدَ لِلَّهِ نَحْمَدُهُ وَنَسْتَعِينُهُ وَنَسْتَغْفِرُهُ',
    type: 'sermon',
    en: 'Indeed, all praise is due to Allah; we praise Him, seek His help, and ask His forgiveness.',
    bn: 'নিশ্চয় সমস্ত প্রশংসা আল্লাহর জন্য, আমরা তাঁরই প্রশংসা করি, তাঁরই কাছে সাহায্য চাই এবং তাঁর কাছে ক্ষমা প্রার্থনা করি।',
    ur: 'تمام تعریفیں اللہ کے لیے ہیں، ہم اسی کی تعریف کرتے ہیں، اسی سے مدد مانگتے ہیں اور اسی سے بخشش چاہتے ہیں۔',
    fr: 'Toutes les louanges sont à Allah, nous Le louons, nous implorons Son secours et nous Lui demandons pardon.',
    zh: '一切赞颂，全归真主，我们赞美他，求他相助，求他宽恕。',
    'zh-TW': '一切讚頌，全歸真主，我們讚美祂，求祂相助，求祂寬恕。',
    tr: 'Hamd yalnızca Allah\'adır; O\'na hamdeder, O\'ndan yardım diler ve O\'ndan bağışlanma dileriz.',
    uz: 'Albatta, barcha maqtovlar Allohga xosdir, Biz Unga hamd aytamiz, Undan yordam va mag‘firat so‘raymiz.',
    id: 'Sesungguhnya segala puji bagi Allah, kami memuji-Nya, memohon pertolongan-Nya, dan memohon ampunan-Nya.',
    so: 'Hubaashii amaan oo dhan waxay u sugnaatay Alle, isaga ayaan u mahadnaqaynaa, gargaar iyo dambi dhaafna waydiisanaynaa.'
  },
  {
    arabic: 'وَنَعُوذُ بِاللَّهِ مِنْ شُرُورِ أَنْفُسِنَا وَمِنْ سَيِّئَاتِ أَعْمَالِنَا',
    type: 'sermon',
    en: 'And we seek refuge in Allah from the evils of ourselves and from our bad deeds.',
    bn: 'এবং আমরা আমাদের আত্মার মন্দ থেকে এবং আমাদের খারাপ আমল থেকে আল্লাহর আশ্রয় চাই।',
    ur: 'اور ہم اپنے نفس کے شر اور اپنے برے اعمال سے اللہ کی پناہ مانگتے ہیں۔',
    fr: 'Et nous cherchons refuge auprès d\'Allah contre la méchanceté de nos âmes et les mauvais penchants de nos actions.',
    zh: '我们求真主庇佑，免遭自身之恶和恶行的伤害。',
    'zh-TW': '我們求真主庇佑，免遭自身之惡和惡行的傷害。',
    tr: 'Nefislerimizin şerlerinden ve amellerimizin kötülüklerinden Allah\'a sığınırız.',
    uz: 'Va o‘z nafsimiz yomonligidan va yomon amallarimizdan Allohdan panoh so‘raymiz.',
    id: 'Dan kami berlindung kepada Allah dari kejahatan diri kami dan keburukan amal perbuatan kami.',
    so: 'Waxaan Alle ka magangalaynaa sharka nafteena iyo xumaanta camalkeena.'
  },
  {
    arabic: 'مَنْ يَهْدِهِ اللَّهُ فَلَا مُضِلَّ لَهُ، وَمَنْ يُضْلِلْ فَلَا هَادِيَ لَهُ',
    type: 'sermon',
    en: 'Whomsoever Allah guides, no one can lead astray, and whomsoever He allows to stray, no one can guide.',
    bn: 'আল্লাহ যাকে পথ দেখান তাকে কেউ পথভ্রষ্ট করতে পারে না, আর যাকে তিনি পথভ্রষ্ট করেন তাকে কেউ পথ দেখাতে পারে না।',
    ur: 'جسے اللہ ہدایت دے اسے کوئی گمراہ نہیں کر سکتا، اور جسے وہ گمراہ کر دے اسے کوئی ہدایت دینے والا نہیں۔',
    fr: 'Celui qu\'Allah guide ne sera jamais égaré, et celui qu\'Il égare ne trouvera aucun guide.',
    zh: '真主引导谁，谁就绝不迷路；真主使谁迷途，谁就绝无引导。',
    'zh-TW': '真主引導誰，誰就絕不迷路；真主使誰迷途，誰就絕無引導。',
    tr: 'Allah kime hidayet verirse onu saptıracak yoktur; kimi de saptırırsa ona hidayet verecek yoktur.',
    uz: 'Alloh kimni hidoyat qilsa, uni adashtiruvchi yo‘q, kimni adashtirsa, unga hidoyat qiluvchi yo‘q.',
    id: 'Barangsiapa yang diberi petunjuk oleh Allah maka tidak ada yang dapat menyesatkannya.',
    so: 'Qofka Alle hanuuniyo ma jiro wax lumin kara, qofka uu lumiyana ma jiro wax hanuunin kara.'
  },
  {
    arabic: 'وَأَشْهَدُ أَنْ لَا إِلَهَ إِلَّا اللَّهُ وَحْدَهُ لَا شَرِيكَ لَهُ، وَأَشْهَدُ أَنَّ مُحَمَّدًا عَبْدُهُ وَرَسُولُهُ',
    type: 'sermon',
    en: 'And I bear witness that there is no god but Allah alone without partner, and I bear witness that Muhammad is His servant and messenger.',
    bn: 'এবং আমি সাক্ষ্য দিচ্ছি যে, এক আল্লাহ ব্যতীত কোন সত্য উপাস্য নেই, তাঁর কোন অংশীদার নেই, এবং মুহাম্মদ তাঁর বান্দা ও রাসূল।',
    ur: 'اور میں گواہی دیتا ہوں کہ اللہ کے سوا کوئی معبود نہیں وہ اکیلا ہے، اور محمد اس کے بندے اور رسول ہیں۔',
    fr: 'Et j\'atteste qu\'il n\'y a de divinité digne d\'adoration qu\'Allah, Seul sans associé, et que Muhammad est Son serviteur et Son messager.',
    zh: '我见证万物非主，唯有真主，独一无偶；我又见证穆罕默德是他的仆人和使者。',
    'zh-TW': '我見證萬物非主，唯有真主，獨一無偶；我又見證穆罕默德是祂的僕人和使者。',
    tr: 'Ve şehadet ederim ki Allah\'tan başka ilah yoktur, O tektir, ortağı yoktur; ve yine şehadet ederim ki Muhammed O\'nun kulu ve elçisidir.',
    uz: 'Va guvohlik beramanki, Allohdan o‘zga iloh yo‘q, U yakkadir, sherigi yo‘q; va Muhammad Uning bandasi va elchisidir.',
    id: 'Dan aku bersaksi bahwa tidak ada tuhan selain Allah Yang Maha Esa tiada sekutu bagi-Nya, dan Muhammad adalah hamba dan rasul-Nya.',
    so: 'Waxaan markhaati ka ahay inaan Ilaah kale jirin Alle mooyee, Muxammadna yahay addoonkiisii iyo rasuulkiisii.'
  },
  {
    arabic: 'يَا أَيُّهَا الَّذِينَ آمَنُوا اتَّقُوا اللَّهَ حَقَّ تُقَاتِهِ وَلَا تَمُوتُنَّ إِلَّا وَأَنتُم مُّسْلِمُونَ',
    type: 'quran',
    en: 'O you who have believed, fear Allah as He should be feared and do not die except as Muslims.',
    bn: 'হে ঈমানদারগণ! তোমরা আল্লাহকে যেমন ভয় করা উচিত তেমন ভয় কর এবং আত্মসমর্পণকারী (মুসলিম) না হয়ে মৃত্যুবরণ করো না।',
    ur: 'اے ایمان والو! اللہ سے ڈرو جیسا کہ اس سے ڈرنے کا حق ہے اور تمہیں موت نہ آئے مگر اس حال میں کہ تم مسلمان ہو۔',
    fr: 'Ô vous qui croyez ! Craignez Allah comme Il doit être craint, et ne mourez qu\'en étant musulmans.',
    zh: '信道的人们啊！你们应当真实地敬畏真主，你们除非成了顺服者，切莫死去。',
    'zh-TW': '信道的人們啊！你們應當真實地敬畏真主，你們除非成了順服者，切莫死去。',
    tr: 'Ey iman edenler! Allah\'tan O\'na yaraşır şekilde korkun ve ancak Müslüman olarak can verin.',
    uz: 'Ey iymon keltirganlar! Allohdan Unga munosib ravishda qo‘rqinglar va musulmon bo‘lmagan holda vafot etmanglar.',
    id: 'Wahai orang-orang yang beriman! Bertakwalah kepada Allah dengan sebenar-benar takwa kepada-Nya dan janganlah kamu mati kecuali dalam keadaan Muslim.',
    so: 'Kuwa xaqa rumeeyow! Ka dhawrsada Eebbe dhawrasho xaq ah hana dhimanina idinkoo Muslimiin ah mooyee.'
  },
  {
    arabic: 'أَيُّهَا الإِخْوَةُ الكِرَامُ، اتَّقُوا اللَّهَ تَعَالَى وَاعْلَمُوا أَنَّ الحَيَاةَ الدُّنْيَا دَارُ امْتِحَانٍ',
    type: 'sermon',
    en: 'Respected brothers, fear Allah the Almighty, and know that this worldly life is a realm of trial.',
    bn: 'হে সম্মানিত ভাইয়েরা, সর্বশক্তিমান আল্লাহকে ভয় করুন এবং জেনে রাখুন যে এই পার্থিব জীবন একটি পরীক্ষার স্থান।',
    ur: 'معزز بھائیو! اللہ تعالیٰ کا تقویٰ اختیار کرو اور جان لو کہ یہ دنیا امتحان کا گھر ہے۔',
    fr: 'Chers frères, craignez Allah le Très-Haut et sachez que la vie d\'ici-bas est une épreuve.',
    zh: '尊贵的兄弟们，应当敬畏至尊的真主，并当知道今世是考验的场所。',
    'zh-TW': '尊貴的兄弟們，應當敬畏至尊的真主，並當知道今世是考驗的場所。',
    tr: 'Ey aziz kardeşler! Yüce Allah\'tan sakının ve bilin ki bu dünya hayatı bir imtihan yurdudur.',
    uz: 'Ey aziz birodarlar! Alloh taolodan qo‘rqing va bilingki, bu dunyo hayoti bir imtihan maskanidir.',
    id: 'Wahai saudara-saudaraku yang mulia, bertakwalah kepada Allah dan ketahuilah bahwa kehidupan dunia ini adalah tempat ujian.',
    so: 'Walaalayaal sharaf leh, ka cabsada Eebbe kor ahaaye oo ogaada in noloshan adduunyo tahay guri imtixaan.'
  },
  {
    arabic: 'فَإِنَّ مَعَ الْعُسْرِ يُسْرًا، إِنَّ مَعَ الْعُسْرِ يُسْرًا',
    type: 'quran',
    en: 'For indeed, with hardship [will be] ease. Indeed, with hardship [will be] ease.',
    bn: 'সুতরাং কষ্টের সাথেই তো স্বস্তি আছে, নিশ্চয় কষ্টের সাথেই স্বস্তি আছে।',
    ur: 'پس بیشک تنگی کے ساتھ آسانی ہے، بیشک تنگی کے ساتھ آسانی ہے۔',
    fr: 'À côté de la difficulté est, certes, une facilité ! À côté de la difficulté est, certes, une facilité !',
    zh: '与艰难相伴的，确是容易；与艰难相伴的，确是容易。',
    'zh-TW': '與艱難相伴的，確是容易；與艱難相伴的，確是容易。',
    tr: 'Elbette zorlukla beraber bir kolaylık vardır. Gerçekten, zorlukla beraber bir kolaylık vardır.',
    uz: 'Bas, albatta, qiyinchilik bilan birga yengillik bordir. Albatta, qiyinchilik bilan birga yengillik bordir.',
    id: 'Maka sesungguhnya bersama kesulitan ada kemudahan, sesungguhnya bersama kesulitan ada kemudahan.',
    so: 'Dhibka ka dibna fudeyd baa jira, dhab ahaan dhibka ka dibna fudeyd baa jira.'
  },
  {
    arabic: 'فَاسْتَغْفِرُوا اللَّهَ يَغْفِرْ لَكُمْ، إِنَّهُ هُوَ الغَفُورُ الرَّحِيمُ',
    type: 'sermon',
    en: 'So seek forgiveness from Allah, He will forgive you; indeed, He is the Forgiving, the Merciful.',
    bn: 'সুতরাং তোমরা আল্লাহর কাছে ক্ষমা প্রার্থনা কর, তিনি তোমাদের ক্ষমা করবেন; নিশ্চয় তিনি পরম ক্ষমাশীল, পরম দয়ালু।',
    ur: 'پس تم اللہ سے مغفرت طلب کرو وہ تمہیں معاف فرما دے گا، بیشک وہی معاف فرمانے والا، نہایت رحم کرنے والا ہے۔',
    fr: 'Demandez donc pardon à Allah, Il vous pardonnera; car Il est le Pardonneur, le Très Miséricordieux.',
    zh: '你们当向真主求饶，他必饶恕你们；他确是至赦的，至慈的。',
    'zh-TW': '你們當向真主求饒，祂必饒恕你們；祂確是至赦的，至慈的。',
    tr: 'Öyleyse Allah\'tan bağışlanma dileyin ki sizi bağışlasın; şüphesiz O, çok bağışlayan ve çok merhamet edendir.',
    uz: 'Bas, Allohdan mag‘firat so‘rang, U sizlarni kechiradi; albatta, U kechiruvchi va mehribondir.',
    id: 'Maka mohonlah ampunan kepada Allah, niscaya Dia mengampunimu; sesungguhnya Dia Maha Pengampun lagi Maha Penyayang.',
    so: 'Ee Eebbe dambi dhaaf weydiista wuu idiin dambi dhaafiye, isagu waa dambi dhaafe naxariista.'
  },
  {
    arabic: 'اللَّهُمَّ اغْفِرْ لِلْمُسْلِمِينَ وَالْمُسْلِمَاتِ، الأَحْيَاءِ مِنْهُمْ وَالأَمْوَاتِ',
    type: 'dua',
    en: 'O Allah, forgive all Muslim men and women, those who are living and those who have passed away.',
    bn: 'হে আল্লাহ, সকল মুসলিম নর-নারীকে ক্ষমা করে দিন, তাদের জীবিত ও মৃত সবাইকে।',
    ur: 'اے اللہ! تمام مسلمان مردوں اور عورتوں کو معاف فرما، ان میں سے جو زندہ ہیں اور جو وفات پا چکے ہیں۔',
    fr: 'Ô Allah, pardonne aux croyants et aux croyantes, vivants comme morts.',
    zh: '主啊！求你宽恕所有穆斯林男女，无论生者还是亡人。',
    'zh-TW': '主啊！求祢寬恕所有穆斯林男女，無論生者還是亡人。',
    tr: 'Allah\'ım! Mümin erkekleri ve mümin kadınları, yaşayanlarını ve vefat etmiş olanlarını bağışla.',
    uz: 'Yo Alloh, barcha musulmon erkak va ayollarni, ularning tiriklari va vafot etganlarini mag‘firat qil.',
    id: 'Ya Allah, ampunilah seluruh kaum muslimin dan muslimat, baik yang masih hidup maupun yang telah wafat.',
    so: 'Ilaahow u dambi dhaaf muslimiinta rag iyo dumarba, kuwa nool iyo kuwa dhintayba.'
  }
];

class SonioxGateManager extends EventEmitter {
  constructor(apiKey = process.env.SONIOX_API_KEY) {
    super();
    this.apiKey = (apiKey || '').trim();
    this.activeGates = new Map(); // langCode -> GateConnection
    this.isOperational = this.validateApiKey(this.apiKey);

    // Real-Time Streaming Simulation State
    this.isSimulating = false;
    this.simSessionId = null;
    this.simTargetLangs = ['en'];
    this.simIndex = 0;
    this.simIntervalMs = 95; // ~95ms per token for true sub-100ms streaming feeling
    this.simStepTimer = null;
    this.simPauseTimer = null;

    if (this.isOperational) {
      console.log('[Soniox] Dynamic Language Gates initialized with active API key.');
    } else {
      console.log('[Soniox] No live SONIOX_API_KEY provided. Ready in High-Fidelity Streaming Simulation & Fallback mode.');
    }
  }

  validateApiKey(key) {
    return Boolean(key && key.length > 5 && !key.includes('your_') && !key.includes('placeholder'));
  }

  isConfigured() {
    return this.isOperational;
  }

  setApiKey(key) {
    this.apiKey = (key || '').trim();
    this.isOperational = this.validateApiKey(this.apiKey);
  }

  /**
   * Synchronize active language gates with the currently required languages.
   * @param {Array<string>|Set<string>} requiredLanguages - List of active language codes
   */
  syncGates(requiredLanguages) {
    if (!this.isOperational) return;

    const reqSet = new Set(Array.from(requiredLanguages || []).filter(l => l && typeof l === 'string'));
    
    // 1. Open new gates for newly requested languages
    for (const lang of reqSet) {
      this.ensureGate(lang);
    }

    // 2. Close gates for languages that are no longer requested
    for (const [lang, gate] of this.activeGates.entries()) {
      if (!reqSet.has(lang)) {
        console.log(`[Soniox Gate] 0 listeners remaining for "${lang}" — closing gate ($0 cost).`);
        this.closeGate(lang);
      }
    }
  }

  /**
   * Ensures a dedicated Soniox WebSocket stream exists for a specific target language.
   * @param {string} langCode - Target language (e.g., 'en', 'bn', 'ur', 'zh')
   */
  ensureGate(langCode) {
    if (!this.isOperational || !langCode) return null;

    const existing = this.activeGates.get(langCode);
    if (existing && (existing.status === 'open' || existing.status === 'connecting')) {
      return existing;
    }

    console.log(`[Soniox Gate] Opening dynamic gate for target language: "${langCode}" ($0.18/hr)...`);

    const gate = {
      lang: langCode,
      ws: null,
      status: 'connecting',
      audioQueue: [],
      currentOriginalText: '',
      currentTranslatedText: '',
      reconnectAttempts: 0,
      createdAt: Date.now()
    };

    this.activeGates.set(langCode, gate);
    this.connectGate(gate);
    return gate;
  }

  connectGate(gate) {
    if (!this.isOperational) return;

    try {
      const ws = new WebSocket(SONIOX_WS_ENDPOINT, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      gate.ws = ws;

      ws.on('open', () => {
        gate.status = 'open';
        gate.reconnectAttempts = 0;
        console.log(`[Soniox Gate] Connected & ready for language "${gate.lang}".`);

        // Send Soniox start configuration payload
        const configMessage = {
          model: DEFAULT_MODEL,
          audio_format: 'pcm_s16le',
          sample_rate: SAMPLE_RATE,
          num_channels: NUM_CHANNELS,
          translation: {
            type: 'one_way',
            target_language: gate.lang
            // Note: source_language is omitted to allow auto-detection ("detect any")
          }
        };

        ws.send(JSON.stringify(configMessage));

        // Flush any buffered audio chunks
        if (gate.audioQueue.length > 0) {
          while (gate.audioQueue.length > 0) {
            const chunk = gate.audioQueue.shift();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(chunk);
            }
          }
        }
      });

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          this.handleSonioxMessage(gate, data);
        } catch (err) {
          console.warn(`[Soniox Gate ${gate.lang}] Message parse error:`, err.message);
        }
      });

      ws.on('error', (err) => {
        console.warn(`[Soniox Gate ${gate.lang}] WS Error:`, err.message);
        gate.status = 'error';
      });

      ws.on('close', (code, reason) => {
        console.log(`[Soniox Gate ${gate.lang}] WS Closed (${code}): ${reason || 'Normal'}`);
        gate.status = 'closed';

        // Auto-reconnect if gate is still desired in active map
        if (this.activeGates.has(gate.lang) && gate.reconnectAttempts < 5) {
          gate.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, gate.reconnectAttempts), 10000);
          setTimeout(() => {
            if (this.activeGates.has(gate.lang)) {
              this.connectGate(gate);
            }
          }, delay);
        }
      });

    } catch (err) {
      console.error(`[Soniox Gate ${gate.lang}] Connection exception:`, err.message);
      gate.status = 'error';
    }
  }

  /**
   * Parse Soniox streaming tokens and dispatch
   */
  handleSonioxMessage(gate, data) {
    if (!data) return;

    // Check for tokens array
    const tokens = data.tokens || (data.result && data.result.tokens) || [];
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    let hasTranslation = false;
    let hasOriginal = false;
    let translatedWords = [];
    let originalWords = [];
    let isFinal = false;

    for (const token of tokens) {
      const text = token.text || '';
      const status = token.translation_status || 'none';
      if (token.is_final) isFinal = true;

      if (status === 'translation') {
        hasTranslation = true;
        translatedWords.push(text);
      } else if (status === 'original' || status === 'none') {
        hasOriginal = true;
        originalWords.push(text);
      }
    }

    const translatedTextChunk = translatedWords.join('');
    const originalTextChunk = originalWords.join('');

    if (hasTranslation || hasOriginal) {
      this.emit('token_stream', {
        lang: gate.lang,
        translatedChunk: translatedTextChunk,
        originalChunk: originalTextChunk,
        isFinal: Boolean(isFinal),
        timestamp: new Date().toISOString()
      });
    }

    if (isFinal) {
      // Sentence finalized
      this.emit('sentence_finalized', {
        lang: gate.lang,
        translatedText: translatedTextChunk,
        originalText: originalTextChunk,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Broadcast audio buffer to all open language gates (Audio Fan-Out)
   * @param {Buffer} pcmBuffer - 16kHz, 16-bit mono PCM audio
   */
  broadcastAudio(pcmBuffer) {
    if (!this.isOperational || !pcmBuffer || !Buffer.isBuffer(pcmBuffer)) return;

    for (const [lang, gate] of this.activeGates.entries()) {
      if (gate.status === 'open' && gate.ws && gate.ws.readyState === WebSocket.OPEN) {
        try {
          gate.ws.send(pcmBuffer);
        } catch (e) {
          console.warn(`[Soniox Gate ${lang}] Send error:`, e.message);
        }
      } else if (gate.status === 'connecting') {
        // Buffer up to 100 chunks while establishing handshake
        if (gate.audioQueue.length < 100) {
          gate.audioQueue.push(pcmBuffer);
        }
      }
    }
  }

  /**
   * Close a specific language gate
   * @param {string} langCode
   */
  closeGate(langCode) {
    const gate = this.activeGates.get(langCode);
    if (!gate) return;

    this.activeGates.delete(langCode);
    if (gate.ws) {
      try {
        gate.ws.close(1000, 'Gate closed by manager');
      } catch (_) {}
    }
    gate.status = 'closed';
  }

  /**
   * Close all active gates (e.g. when session ends)
   */
  closeAllGates() {
    for (const lang of Array.from(this.activeGates.keys())) {
      this.closeGate(lang);
    }
  }

  // -------------------------------------------------------------------------
  // Real-Time Word-by-Word Streaming Simulation Engine (<100ms Per Token)
  // -------------------------------------------------------------------------

  /**
   * Starts high-fidelity word-by-word streaming simulation.
   * Emits `token_stream` tokens every 80-120ms so TV and mobile devices
   * experience the exact real-time Soniox translation speed.
   */
  startStreamingSimulation(sessionId, targetLangs = ['en'], intervalMs = 95) {
    this.stopStreamingSimulation();
    this.isSimulating = true;
    this.simSessionId = sessionId;
    this.simTargetLangs = Array.from(new Set((targetLangs && targetLangs.length ? targetLangs : ['en']).filter(Boolean)));
    this.simIndex = 0;
    this.simIntervalMs = Math.max(60, Math.min(intervalMs || 95, 200));

    console.log(`[Soniox Streaming Engine] Real-time token simulation started (${this.simIntervalMs}ms intervals, langs: [${this.simTargetLangs.join(', ')}]).`);

    this.runNextSimulationSentence();
  }

  /**
   * Update active simulation languages dynamically when attendees switch/join
   */
  updateSimulationLanguages(langs) {
    if (!Array.isArray(langs)) return;
    const cleanLangs = Array.from(new Set(langs.filter(Boolean)));
    if (cleanLangs.length > 0) {
      this.simTargetLangs = cleanLangs;
    }
  }

  runNextSimulationSentence() {
    if (!this.isSimulating) return;

    if (this.simIndex >= KHUTBAH_SIMULATION_CORPUS.length) {
      this.simIndex = 0;
    }

    const sentence = KHUTBAH_SIMULATION_CORPUS[this.simIndex];
    const arWords = sentence.arabic.trim().split(/\s+/).filter(Boolean);

    // Pre-split translations into words for each active language
    const langWordsMap = {};
    for (const lang of this.simTargetLangs) {
      const transText = sentence[lang] || sentence.en || sentence.arabic;
      langWordsMap[lang] = transText.trim().split(/\s+/).filter(Boolean);
    }

    const totalSteps = Math.max(arWords.length, 6);
    this.emitNextTokenStep(sentence, arWords, langWordsMap, 0, totalSteps);
  }

  emitNextTokenStep(sentence, arWords, langWordsMap, step, totalSteps) {
    if (!this.isSimulating) return;

    const isFinal = (step >= totalSteps - 1);
    const arChunk = arWords[step] || '';

    // Emit token_stream for each active target language
    for (const lang of this.simTargetLangs) {
      const langWords = langWordsMap[lang] || [];
      const startIdx = Math.floor((step * langWords.length) / totalSteps);
      const endIdx = isFinal ? langWords.length : Math.floor(((step + 1) * langWords.length) / totalSteps);
      const chunkWords = langWords.slice(startIdx, endIdx);
      const translatedChunk = chunkWords.length > 0 ? (chunkWords.join(' ')) : '';

      this.emit('token_stream', {
        lang,
        translatedChunk,
        originalChunk: arChunk,
        isFinal,
        timestamp: new Date().toISOString()
      });
    }

    if (isFinal) {
      // Build full translations dictionary
      const allTranslations = {};
      for (const [k, v] of Object.entries(sentence)) {
        if (k !== 'arabic' && k !== 'type') {
          allTranslations[k] = v;
        }
      }

      // Sentence is complete — emit finalized event for Quran detection and history archive
      for (const lang of this.simTargetLangs) {
        this.emit('sentence_finalized', {
          lang,
          translatedText: sentence[lang] || sentence.en,
          originalText: sentence.arabic,
          translations: allTranslations,
          timestamp: new Date().toISOString()
        });
      }

      // Natural speech pause between sentences (~1.2 seconds), then proceed
      this.simPauseTimer = setTimeout(() => {
        if (!this.isSimulating) return;
        this.simIndex = (this.simIndex + 1) % KHUTBAH_SIMULATION_CORPUS.length;
        this.runNextSimulationSentence();
      }, 1200);

    } else {
      // Schedule next token
      this.simStepTimer = setTimeout(() => {
        if (!this.isSimulating) return;
        this.emitNextTokenStep(sentence, arWords, langWordsMap, step + 1, totalSteps);
      }, this.simIntervalMs);
    }
  }

  stopStreamingSimulation() {
    this.isSimulating = false;
    if (this.simStepTimer) {
      clearTimeout(this.simStepTimer);
      this.simStepTimer = null;
    }
    if (this.simPauseTimer) {
      clearTimeout(this.simPauseTimer);
      this.simPauseTimer = null;
    }
    console.log('[Soniox Streaming Engine] Simulation stopped.');
  }

  /**
   * Stream a single injected sentence word-by-word at 85ms token intervals.
   * Delivers instantaneous word-by-word animation for manual speech input.
   */
  async streamInjectedSentence(text, targetLangs = ['en'], translationsMap = null) {
    if (!text || typeof text !== 'string') return;
    const cleanText = text.trim();
    if (!cleanText) return;

    // Check if sentence exists in our corpus
    const match = KHUTBAH_SIMULATION_CORPUS.find(s => s.arabic.includes(cleanText) || cleanText.includes(s.arabic));
    const trans = translationsMap || (match ? { ...match } : { en: cleanText });

    const arWords = cleanText.split(/\s+/).filter(Boolean);
    const langs = Array.from(new Set((targetLangs && targetLangs.length ? targetLangs : ['en']).filter(Boolean)));
    const totalSteps = Math.max(arWords.length, 5);

    for (let step = 0; step < totalSteps; step++) {
      const isFinal = (step === totalSteps - 1);
      const arChunk = arWords[step] || '';

      for (const lang of langs) {
        const fullTrans = trans[lang] || trans.en || cleanText;
        const langWords = fullTrans.split(/\s+/).filter(Boolean);
        const startIdx = Math.floor((step * langWords.length) / totalSteps);
        const endIdx = isFinal ? langWords.length : Math.floor(((step + 1) * langWords.length) / totalSteps);
        const chunk = langWords.slice(startIdx, endIdx).join(' ');

        this.emit('token_stream', {
          lang,
          translatedChunk: chunk,
          originalChunk: arChunk,
          isFinal,
          timestamp: new Date().toISOString()
        });
      }

      if (!isFinal) {
        await new Promise(r => setTimeout(r, 85));
      }
    }

    for (const lang of langs) {
      this.emit('sentence_finalized', {
        lang,
        translatedText: trans[lang] || trans.en || cleanText,
        originalText: cleanText,
        translations: trans,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Get current gate status for monitoring and health check
   */
  getStatus() {
    return {
      operational: this.isOperational,
      isSimulating: Boolean(this.isSimulating),
      activeEngine: this.isOperational ? 'soniox_live_cloud' : (this.isSimulating ? 'soniox_streaming_sim' : 'soniox_local_pipeline'),
      activeGateCount: this.activeGates.size,
      activeLanguages: Array.from(this.activeGates.keys()),
      estimatedHourlyCost: (this.activeGates.size * 0.18).toFixed(2) + ' USD/hr',
      apiKeyConfigured: Boolean(this.apiKey && this.apiKey.length > 5)
    };
  }
}

module.exports = new SonioxGateManager();
module.exports.KHUTBAH_SIMULATION_CORPUS = KHUTBAH_SIMULATION_CORPUS;
