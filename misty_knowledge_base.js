/* ============================================================================
   MISTY MOUNTAIN — CHATBOT KNOWLEDGE BASE
   ----------------------------------------------------------------------------
   Loaded by index.html as a classic script (no modules, so it works from
   file:// as well as from a server). Everything is published on
   window.MM_* and the page degrades gracefully if this file is absent.

   Three datasets:
     MM_MEDIA   verified photographs, each one checked by eye against the thing
                it is captioned as. Sourced from the resort's own site.
     MM_PLACES  nearby locations, with a Google Maps query string rather than a
                hand-written URL, so the link is always well formed.
     MM_QA      1,000 question/answer pairs. Every answer is grounded in what
                the estate publishes; where something is not published the
                answer says so and points at a person. No invented facts.

   Field reference for MM_QA entries:
     q  question (the canonical phrasing)
     a  answer (HTML permitted: <strong>, <a>)
     c  category id
     t  extra retrieval tags, space separated
     m  media key from MM_MEDIA.sets — attaches a picture strip
     p  place keys from MM_PLACES — attaches location cards
   ========================================================================== */

(function (root) {
  "use strict";

  /* --------------------------------------------------------------------------
     1. MEDIA
     Base is the resort's own image CDN. Each id was downloaded and visually
     confirmed before being captioned; nothing here is a stock stand-in.
     -------------------------------------------------------------------------- */

  var CDN = "https://framerusercontent.com/images/";
  // This CDN ignores ?width= but honours ?scale-down-to=. Without it the raw
  // originals come down — one of the barbecue photographs is 4.7 MB against
  // 44 KB resized — which is the difference between a strip of pictures that
  // appears with the answer and one that trickles in half a minute later.
  // 512 covers the grid at 2x on the widest layout the panel ever uses.
  var W = "?scale-down-to=512";

  function img(id, alt) { return { src: CDN + id + W, full: CDN + id, alt: alt }; }

  var PIC = {
    /* ---- Wooden Chalet ---- */
    chaletExterior:   img("0DVVsrZyfwFyEtiF1TvTtXMMBdQ.jpg", "A Wooden Chalet raised on stilts among the plantation trees"),
    chaletStilts:     img("LWSoZ6GTVVqZKEa1wd0Df9muZI.jpg",  "Wooden Chalet on stilts, timber balcony facing the forest"),
    chaletForest:     img("44y2zUmGkpfzNFS9wjQNnbwbZIA.webp","Wooden Chalet set into dense green plantation"),
    chaletRow:        img("DznoxN6PXldvCQ8q55zqmHNrH8.jpeg", "Wooden Chalets in a row along a stone path"),
    chaletPath:       img("4KqC7534m5kOSXpapLClnsARakA.jpeg","Wooden Chalet with a stepping-stone path and lawn"),
    chaletGarden:     img("xs4f1Sjq92ouKIxlz68dxaq5mg.jpeg", "Wooden Chalet with a small lawn and stone retaining wall"),
    chaletSide:       img("MV3XJ9GcxUlebwoStQQnuz3cnQ.jpeg", "Timber wall and windows of a Wooden Chalet"),
    chaletInterior:   img("jKuajXKcOszq1U4k1iUQDie9jg.jpg",  "Inside a Wooden Chalet — timber ceiling, bed and desk"),
    chaletInterior2:  img("IVoahCl47FILqFEDci9gsUrtzpQ.jpg", "Wooden Chalet bedroom with timber walls and a window seat"),
    chaletBath:       img("kyPzmWgTGkW0BuXSLpfBarpGc.jpg",   "Wooden Chalet bathroom — basin, mirror and timber panelling"),

    /* ---- Reverie Cottages ---- */
    reverieStone:     img("94XYRZHW2VFd0LUboSM9gtodRLs.jpeg","Reverie Cottages — stone walls and a first-floor balcony"),
    reverieGreen:     img("GDUp01yNCXLFxxEcT07XaEwk.jpeg",   "Stone-built Reverie Cottage among the plantation"),
    reverieWater:     img("tfOmEHbgqDlHu3OQX80c312UmwI.jpeg","Reverie Cottages seen from below, above the water"),
    reverieRoof:      img("TMItO9X87b2ek4rzClbXQcLN9ts.png", "Reverie Cottage with a tiled roof, framed by trees"),
    reverieTea:       img("NoyJVv7ntP5TA8MECrmXhmfG84.webp", "Stone cottage standing in the tea"),
    reverieSteps:     img("PvhhIsXpXQg1kR5NJBm1cwMdmQ.webp", "Stone cottage with a stepped path climbing to it"),
    reverieWalk:      img("5I097fEQlC3RUO3A6B78ispQRw.png",  "Walkway along the stone face of the Reverie Cottages"),
    reverieRoofline:  img("aanogEXSbX8FVeHrJdYP2vd5xEI.png", "Cottage roofline seen over the tree canopy"),
    reverieInterior:  img("MggAG8dmj9NBKKaJCOIz2lYxx8.jpeg", "Reverie room interior with a balcony door and LED TV"),
    reverieBed:       img("da16h1qCOi6CauHd2yT0yyMEwU.png",  "Reverie bedroom — twin lamps and a made bed"),
    reverieBed2:      img("z9qGwq7qClvJFb5Tx0lMzc9Xy3M.png", "Reverie bedroom with warm lamplight"),
    reverieView:      img("sAjyQldQxkDljCR3or3Gilzjy4.jpg",  "Reverie room looking out through full-height windows"),
    reverieBath:      img("b3DRf20m47ISmoj1qdCUcC9N0.png",   "Tiled bathroom with a walk-in shower"),
    lawnWall:         img("VnvYKoooX0EMxXzYeFZzLdFfks.webp", "Lawn and stone retaining wall in front of the cottages"),

    /* ---- Restaurants ---- */
    teylaDay:         img("9l0cNWETLlRjjQz8KcpfOajMDA.webp", "Teyla Plantation Restaurant — A-frame building by day"),
    teylaDusk:        img("dQUPIvbHjKk73qOzzFfEtgbrpOk.jpeg","Teyla Plantation Restaurant lit at dusk"),
    teylaNight:       img("1UvdOp2lO0iwKUy0sTS9RR73k.webp",  "Teyla Plantation Restaurant at nightfall"),
    teylaFront:       img("0SsC49VvxjHPxthiYfbp3rETnPg.jpg", "The front of Teyla Plantation Restaurant"),
    teylaTerrace:     img("Iq9RkaY32nu5376IbdWwKEmciI.jpg",  "Outdoor cafe tables on the terrace"),
    elamInterior:     img("3Q5kKIkPLuPQSY5p7NsbbR2Dig.png",  "Inside Elam Restaurant — laid tables under a pitched roof"),
    elamInterior2:    img("MlEwiFG0jn5Ft98Dsgb3tTKFuAE.webp","Elam Restaurant dining room"),
    elamHall:         img("EsosnL8VWvQOEBzXgTB7oSIEwcQ.webp","The dining hall, planted and glazed on both sides"),
    diningRoom:       img("SSMleIqvyEqZQcdt1UuLkQ5EMrQ.jpeg","Dining room with tables laid for a meal"),
    diningRoom2:      img("zljNGpB9cYuUoUg7j02SEXsJs.jpg",   "Dining room interior"),
    lounge:           img("YFIbAkEm7BGcozxjhqsS2L3c4.webp",  "Lounge with cane chairs around an open fireplace"),
    loungeFire:       img("cwwVKkH9A3LYoAfFJY5bCbDc.jpeg",   "Dining table beside the lounge fireplace"),

    /* ---- Food ---- */
    tandooriChicken:  img("SPqsmlNG4BNFZs8iHUNXN4WB9u0.jpeg","Grilled chicken drumsticks with mint chutney"),
    chickenTikka:     img("U5gG943SBmJ96d2XNrNpKwjMZ0.jpg",  "Chicken tikka off the grill with onion and chutney"),
    kebabPlate:       img("i2btax0xejKaODAegwEalNXZPMQ.png", "A plated kebab with a green marinade"),
    kebabPlate2:      img("y5DG8piuSy5fJsoI0sGPCCjBXg.png",  "Kebabs plated with chutney"),
    idiyappam:        img("Hv8CIAq3CsxEMvw7Nrix9txvo2o.jpg", "Idiyappam with curry, served on a banana leaf"),
    soup:             img("c1CemdTZ3A0pXDZqkaJDLOh7g.png",   "A bowl of soup served on a wooden board"),
    friedRice:        img("AC8hPSDDKbRM9gyTeLhDcNDdO7k.png", "Fried rice with a side of curry"),
    salad:            img("O8O4LEInB7YW4iZ6MltSyM7o.png",    "Watermelon and feta salad"),
    burger:           img("PdZqKkgQH5OfugTAG7aMzJaLw.png",   "A burger plated with sides"),
    sandwich:         img("kMUsCb9cJUfFgnv4ZNvI4hv7OA.png",  "A grilled sandwich, plated"),
    breakfastSitout:  img("j0cMcqLClxSw5Adle1FbpcXLY.jpg",   "Breakfast laid out on a private sit-out table"),
    tandoor:          img("mTYzaqJyj8RGxl8o8MIU1R0xHGo.webp","Skewers cooking in a tandoor"),
    bbqGrill:         img("OTs0dJIG0hnkASMm5Bg5WBltaCs.png", "Barbecue grill over an open flame"),
    bbqGrill2:        img("yOOOyRuqR8R5ZzVhDfykRCoiGk4.webp","Food grilling over the barbecue fire"),

    /* ---- Bakery ---- */
    cakeSwirl:        img("zAFS9xvvjRAX5CzCzuhNDjaCc.jpg",   "A swirled cake finished with flaked almonds"),
    dessertRamekin:   img("KuhCHLtTd5mIfADOISRDKMRRdY.jpg",  "A baked dessert in a ramekin with a tuile"),
    dessertPlated:    img("8ywvE3Vcagup6eqi5tU6DVppAvo.jpg", "Plated desserts finished by the pastry chef"),
    tarts:            img("adUi1zKRnnySAjwp2tm9gFsZBo.jpg",  "Tarts and meringues from the in-house bakery"),
    fruitCake:        img("qXwkvNSZvZpVw38juX6BAl4.png",     "A fruit cake from the bakery"),

    /* ---- Activities ---- */
    teaTasting:       img("r55Ieno422Fd1jBKc3r3m2hV7rQ.png", "Tea tasting — brewed cups beside their dry leaf"),
    chaiTin:          img("IkSV69YjZbCzAtkmMKxgQiTgA.png",   "A tin of Misty Mountain masala chai beside a cup"),
    teaPlucker:       img("qXVDijfxB0QWqJLk9HKvFxOU88.png",  "A plucker working the tea in the rain"),
    teaLeaf:          img("Xk8MQPQ7HKWT0gTakmaOiiYen8.jpg",  "Two leaves and a bud, picked by hand"),
    teaLeaf2:         img("hDbVmdXxMMNIhMhvggUeKuhaH8.png",  "A hand picking fresh tea leaf"),
    jeepMist:         img("a8IG20Ze6EfMGjeCGIsJeLeAi0.png",  "A jeep stopped at a viewpoint in heavy mist"),
    jeepMist2:        img("oYInEJJoCIqjsJTOam1mNeaEh8.png",  "Guests at a misty overlook beside the estate jeep"),
    jeepStream:       img("KlZ9hhfs1ZmCyVxgA7wZxC4Bw0.png",  "A jeep crossing a forest stream"),
    jeepStream2:      img("8dt0NsrIRhMaXzdpCgFDBPnyOCY.webp","The jeep working along a rocky streambed"),
    jeepRocks:        img("EqxzjbCFUJbcFg2j0otV4zugi24.png", "The jeep on rough ground beside falling water"),
    waterfall:        img("Aq3daIGgDwNxhF05OJoQaPc4Q.png",   "The waterfall on the estate, in full flow"),
    waterfallRocks:   img("SYDWclBtbGJn3LRSfVidlqRfa4.webp", "Guests sitting on the rocks by the falls"),
    walkAvenue:       img("Dg29gplTUfXO7Wjvx1YPyRdmtQ.png",  "Two guests walking a tree-lined estate road"),
    walkAvenue2:      img("5Rkm8ahOj04O3llV1LVPtx6t4.webp",  "A shaded avenue through the plantation"),
    trail:            img("mj71Yhryy5gMexOJsXvGtZ4QN8.png",  "A footpath winding through the greenery"),
    cycling:          img("5wdBhWyX60Td6d2LbcvAxR8ToA.png",  "Cyclists stopped on a ridge above the valley"),
    cycling2:         img("nVgSmBdkYSAgVp53Eg0uxXxgLE.webp", "Riders on the high estate road"),
    fishing:          img("R4ZfSfjOsYwwcqnp724gB0IR964.png", "Fishing from the bank of the water reserve"),
    kayak:            img("nxcibykjSx6Uqzh4GWKHLe96K0.png",  "Kayaking on the reservoir"),
    kayak2:           img("dO9VVLDWLIycKcOXwRo7TGbnU.webp",  "A kayak on still water under low cloud"),
    kayak3:           img("AOfiFOOlt8TLrSzSHNWVTXX6XM.webp", "Two paddlers crossing the reservoir in the mist"),
    golfRoom:         img("todgNZQgezamcJYxNDzrthxoZM.png",  "The Golf Room — putting into the virtual simulator"),
    campfire:         img("KOTk6iorUR0kAx0i0nU463U50o.png",  "A campfire burning in a clearing"),
    campfire2:        img("Xj4wHXJzjQ5zlrkjEFZ8AEK7OOQ.webp","Guests sitting around the campfire after dark"),
    embers:           img("mEocFlll01ZINUZObpgrMAXGZA.webp", "Embers rising from the fire"),

    /* ---- The estate ---- */
    estateDawn:       img("Ddcz4gyblJzWUnn1mURPOhk5M.webp",  "The tea estate at first light"),
    estateAerial:     img("U0ngDdPX4rJhxdF8e1k7mM4gmw.png",  "Contour-planted tea seen from the air"),
    mistyHills:       img("TIcr4QSPuwZYuMqhMzwG81cdkr0.jpg", "Cloud sitting down over the ridge"),

    /* ---- Awards ---- */
    awardClove:       img("5gQikI2hb6NZ17PbWXMMqhUgM9Q.webp","Golden Clove award — Best Cafe and Casual Dining, Teyla"),
    awardConclave:    img("X3wm3f0Fz82JBVawhcKUKJOhd4.webp", "Keralam Retail Conclave plaque"),
    awardCert:        img("lgN6pa6A4O9vokXnQUUbzCmBM.webp",  "Hospitality Brand of the Year certificate")
  };

  /* Named picture sets. A Q&A entry references one of these by key. */
  var SETS = {
    chalet:        [PIC.chaletExterior, PIC.chaletInterior, PIC.chaletStilts, PIC.chaletBath],
    chaletOutside: [PIC.chaletStilts, PIC.chaletForest, PIC.chaletRow, PIC.chaletPath],
    chaletInside:  [PIC.chaletInterior, PIC.chaletInterior2, PIC.chaletBath],
    chaletSitout:  [PIC.chaletStilts, PIC.breakfastSitout, PIC.chaletExterior],
    reverie:       [PIC.reverieStone, PIC.reverieInterior, PIC.reverieGreen, PIC.reverieBath],
    reverieOutside:[PIC.reverieGreen, PIC.reverieTea, PIC.reverieWater, PIC.reverieSteps],
    reverieInside: [PIC.reverieInterior, PIC.reverieBed, PIC.reverieView, PIC.reverieBed2],
    reverieBalcony:[PIC.reverieStone, PIC.reverieView, PIC.reverieWalk],
    rooms:         [PIC.chaletExterior, PIC.reverieStone, PIC.chaletInterior, PIC.reverieInterior],
    roomsInside:   [PIC.chaletInterior, PIC.reverieInterior, PIC.reverieBed, PIC.chaletInterior2],
    bathrooms:     [PIC.chaletBath, PIC.reverieBath],
    views:         [PIC.reverieView, PIC.mistyHills, PIC.estateDawn, PIC.chaletStilts],

    dining:        [PIC.teylaDay, PIC.elamInterior, PIC.idiyappam, PIC.cakeSwirl],
    teyla:         [PIC.teylaDay, PIC.teylaDusk, PIC.teylaTerrace, PIC.burger],
    elam:          [PIC.elamInterior, PIC.elamInterior2, PIC.idiyappam, PIC.tandooriChicken],
    restaurants:   [PIC.teylaDay, PIC.elamInterior, PIC.elamHall, PIC.diningRoom],
    lounge:        [PIC.lounge, PIC.loungeFire],
    food:          [PIC.idiyappam, PIC.tandooriChicken, PIC.friedRice, PIC.burger],
    indianFood:    [PIC.idiyappam, PIC.tandooriChicken, PIC.chickenTikka, PIC.kebabPlate],
    keralaFood:    [PIC.idiyappam, PIC.friedRice, PIC.soup],
    continental:   [PIC.salad, PIC.burger, PIC.sandwich, PIC.soup],
    chinese:       [PIC.friedRice, PIC.soup],
    breakfast:     [PIC.breakfastSitout, PIC.idiyappam, PIC.teylaDay],
    bakery:        [PIC.cakeSwirl, PIC.tarts, PIC.fruitCake, PIC.dessertPlated],
    desserts:      [PIC.dessertPlated, PIC.dessertRamekin, PIC.cakeSwirl, PIC.tarts],
    barbecue:      [PIC.bbqGrill, PIC.tandoor, PIC.chickenTikka, PIC.bbqGrill2],
    grill:         [PIC.bbqGrill, PIC.tandooriChicken, PIC.chickenTikka],

    teaTour:       [PIC.teaLeaf, PIC.teaPlucker, PIC.teaTasting, PIC.estateAerial],
    teaTasting:    [PIC.teaTasting, PIC.chaiTin],
    tea:           [PIC.teaLeaf, PIC.teaTasting, PIC.estateDawn, PIC.teaPlucker],
    safari:        [PIC.jeepMist, PIC.jeepStream, PIC.waterfall, PIC.jeepRocks],
    waterfall:     [PIC.waterfall, PIC.waterfallRocks, PIC.jeepRocks],
    walks:         [PIC.walkAvenue, PIC.walkAvenue2, PIC.trail],
    cycling:       [PIC.cycling, PIC.cycling2],
    fishing:       [PIC.fishing],
    kayaking:      [PIC.kayak, PIC.kayak2, PIC.kayak3],
    water:         [PIC.kayak, PIC.fishing, PIC.kayak3],
    golf:          [PIC.golfRoom],
    campfire:      [PIC.campfire, PIC.campfire2, PIC.embers],
    evening:       [PIC.campfire, PIC.bbqGrill, PIC.teylaDusk],
    activities:    [PIC.teaTasting, PIC.jeepMist, PIC.kayak, PIC.campfire],
    estate:        [PIC.estateDawn, PIC.estateAerial, PIC.teaPlucker, PIC.mistyHills],
    weather:       [PIC.mistyHills, PIC.jeepMist, PIC.estateDawn],
    awards:        [PIC.awardClove, PIC.awardCert, PIC.awardConclave],
    shop:          [PIC.chaiTin, PIC.teaTasting]
  };

  /* --------------------------------------------------------------------------
     2. PLACES
     `q` is what gets sent to Google Maps. Building the URL from an encoded
     query — rather than pasting a hand-made link — is what keeps these
     working: the scheme is Google's documented one and the query is a real
     place name plus its locality, so it resolves to the right pin.
     Distances are road distances and are approximate; where sources disagree
     the entry says so rather than inventing precision.
     -------------------------------------------------------------------------- */

  function mapsSearch(q) {
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
  }
  function mapsDirections(q, origin) {
    return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(q) +
           (origin ? "&origin=" + encodeURIComponent(origin) : "");
  }

  var PLACES = {
    resort: {
      name: "Misty Mountain Plantation Resort",
      q: "Misty Mountain Plantation Resort, Kuttikkanam, Peermade, Kerala",
      url: "https://maps.app.goo.gl/KhaJhmVDHHeFbAjbA",
      dist: "The estate itself",
      what: "600 acres of tea and cardamom above Peermade, with Normal and Luxury rooms in the middle of it.",
      detail: "Kuttikkanam PO, Peermade, Idukki District, Kerala 685531.",
      tags: "resort estate misty mountain address here property"
    },
    parunthumpara: {
      name: "Parunthumpara (Eagle Rock)",
      q: "Parunthumpara Eagle Rock View Point, Peermade, Idukki, Kerala",
      dist: "about 7 km from Peermade town",
      what: "A long rock shelf that falls away into the valley — the view everyone is sent up here for.",
      detail: "Best at sunrise or in the last hour of light. The edge is unfenced in places and the rock is slick after rain, so keep well back.",
      tags: "viewpoint view sunrise sunset eagle rock parunthumpara scenic photography"
    },
    peeruHills: {
      name: "Peeru Hills",
      q: "Peeru Hills Peermade",
      dist: "about 5 km from Kuttikkanam",
      what: "The hill the town is named for, with the shrine of the Sufi saint Peer Mohammed on it.",
      detail: "Forest paths and a quiet, spiritual site rather than a viewing platform. Easy to fold into a morning.",
      tags: "peeru hills peermade shrine walk forest history sufi"
    },
    pattumala: {
      name: "Pattumala Church",
      q: "Pattumala Church, Velankanni Matha Church, Pattumala, Kerala",
      dist: "about 8 km from Kuttikkanam",
      what: "A stone church built up among the tea, with a long view back over the plantations.",
      detail: "Also called Velankanni Matha Church. The setting — church, tea and cloud — is the reason to go rather than the building alone.",
      tags: "church pattumala velankanni religious view tea worship mass"
    },
    valanjanganam: {
      name: "Valanjanganam Waterfalls",
      q: "Valanjanganam Waterfalls, Peermade, Idukki, Kerala",
      dist: "about 12 km from Kuttikkanam",
      what: "A tall fall — around 75 feet — dropping into a pool, reached on a short forest trail.",
      detail: "At its best during and just after the monsoon. The rocks around the pool are slippery; not a place to scramble in ordinary shoes.",
      tags: "waterfall valanjanganam falls water trek monsoon pool"
    },
    thekkemala: {
      name: "Thekkemala Waterfalls",
      q: "Thekkemala Waterfall, Peermade, Idukki, Kerala",
      dist: "about 5 km from Kuttikkanam, near Peeru Hills",
      what: "A smaller cascade with natural pools, usually paired with a walk on Peeru Hills.",
      detail: "Quiet on weekdays. Flow depends entirely on recent rain.",
      tags: "waterfall thekkemala falls pool water quiet"
    },
    ammachikottaram: {
      name: "Ammachikottaram (the Summer Palace)",
      q: "Ammachi Kottaram Summer Palace, Peermade, Idukki, Kerala",
      dist: "a short drive from the estate",
      what: "An early twentieth-century royal summer residence, with durbar halls and underground passages.",
      detail: "Built for the Travancore royal family, who came up here to escape the heat of the plains. Distances disagree: the resort's own blog says 10 km from Kuttikkanam, while the map pin sits closer than that. Check the route, and check it is open, before setting out.",
      tags: "palace ammachikottaram summer palace history royal travancore heritage"
    },
    panchalimedu: {
      name: "Panchalimedu",
      q: "Panchalimedu, Idukki, Kerala",
      dist: "about 14 km from Peermade",
      what: "A high grassland meadow tied to the Pandava legend, with a spring said never to run dry.",
      detail: "Open, exposed and windy. A good short trek and a wide view, particularly early.",
      tags: "panchalimedu trek meadow hill legend pandava viewpoint hike"
    },
    peelikunnu: {
      name: "Peelikunnu Viewpoint",
      q: "Peelikunnu, Peermade, Idukki, Kerala",
      dist: "about 6 km from Peermade",
      what: "A quieter viewpoint over the Western Ghats, reached along forest tracks.",
      detail: "Less visited than Parunthumpara, which is rather the point of it.",
      tags: "peelikunnu viewpoint view quiet forest walk scenic"
    },
    ayurvedaMuseum: {
      name: "Sahyadri Ayurveda Museum",
      q: "Sahyadri Ayurveda Museum, Peermade, Idukki, Kerala",
      dist: "close to Peermade town",
      what: "A small museum on Ayurvedic practice and the tribal culture of these hills.",
      detail: "An easy hour, and a sensible option on a day the cloud has come down.",
      tags: "museum ayurveda culture tribal indoor rainy day history"
    },
    vagamon: {
      name: "Vagamon",
      q: "Vagamon, Idukki, Kerala",
      dist: "about 24 km from Kuttikkanam",
      what: "Meadows, a pine forest and paragliding — the busiest hill destination near here.",
      detail: "Best as a half or full day out. Weekends and Kerala holidays get crowded; go early if you want the meadows to yourself.",
      tags: "vagamon meadow pine forest paragliding day trip hill station excursion"
    },
    thekkady: {
      name: "Thekkady / Periyar Tiger Reserve",
      q: "Periyar Tiger Reserve, Thekkady, Kumily, Idukki, Kerala",
      dist: "roughly 35 km, around an hour by road",
      what: "A tiger reserve on a lake, with boat trips, guided walks and a spice-trading town at the gate.",
      detail: "Boat tickets are limited and the good slots go early; book ahead in season. A comfortable full day from here.",
      tags: "thekkady periyar tiger reserve wildlife boat kumily sanctuary elephant day trip"
    },
    kumily: {
      name: "Kumily",
      q: "Kumily, Idukki, Kerala",
      dist: "about 28 km from Peermade",
      what: "The spice town at the gate of Periyar — cardamom, pepper and clove, plus most of the area's shops.",
      detail: "Where to buy spices if you want a wider choice than the estate's own shop.",
      tags: "kumily spice market shopping town periyar cardamom pepper"
    },
    munnar: {
      name: "Munnar",
      q: "Munnar, Idukki, Kerala",
      dist: "96 km — the estate's own published figure",
      what: "The best-known tea country in Kerala, over the hills to the north.",
      detail: "Three hours or so each way on hill road, via Kattappana and Elappara. Really a place to move on to rather than a day trip from here.",
      tags: "munnar tea hill station day trip drive north"
    },
    idukkiDam: {
      name: "Idukki Arch Dam",
      q: "Idukki Arch Dam, Idukki, Kerala",
      dist: "a long half-day; published figures vary between roughly 55 and 65 km",
      what: "One of the tallest arch dams in Asia, thrown across a gorge between two granite hills.",
      detail: "Public access is restricted and varies by season and by year — check before setting out rather than driving on spec.",
      tags: "idukki dam arch dam engineering day trip reservoir"
    },
    kochiAirport: {
      name: "Cochin International Airport (COK)",
      q: "Cochin International Airport, Nedumbassery, Kerala",
      dist: "130 km — the estate's own published figure",
      what: "The nearest international airport, and the one most guests fly into.",
      detail: "Allow around four hours. The route runs Kalady, Perumbavoor, Muvattupuzha, Thodupuzha, Pala and Mundakayam, then climbs to Kuttikkanam.",
      tags: "airport cochin kochi cok flight arrival transfer nedumbassery"
    },
    madurai: {
      name: "Madurai Airport (IXM)",
      q: "Madurai Airport, Madurai, Tamil Nadu",
      dist: "the estate publishes both 173 km and 183 km",
      what: "The nearest airport on the Tamil Nadu side, over the Cumbum pass.",
      detail: "The route runs Usilampatti, Theni, Cumbum, Kumily and Peermade. Two different figures appear on the resort's own site; treat either as approximate.",
      tags: "madurai airport ixm tamil nadu flight arrival"
    },
    kottayam: {
      name: "Kottayam Railway Station",
      q: "Kottayam Railway Station, Kottayam, Kerala",
      dist: "the usual railhead for this stretch of the Ghats",
      what: "The main-line station most guests use, down on the plains.",
      detail: "The estate does not publish a distance to any railway station, so confirm your own timings — but Kottayam is where the Kottayam to Kumily road starts its climb.",
      tags: "train railway station kottayam rail arrival"
    }
  };

  /* --------------------------------------------------------------------------
     3. Q&A CORPUS
     -------------------------------------------------------------------------- */

  var QA = [];

  var CATEGORIES = {
    rooms:      "Rooms and accommodation",
    chalet:     "Wooden Chalets",
    reverie:    "Reverie Cottages",
    amenities:  "Amenities and in-room",
    occupancy:  "Occupancy, children and extra beds",
    dining:     "Dining and restaurants",
    food:       "Dishes and menus",
    diet:       "Dietary requirements",
    activities: "Activities and experiences",
    tea:        "Tea, the factory and the estate",
    outdoors:   "Outdoors, water and wildlife",
    booking:    "Booking and availability",
    money:      "Rates, payment and offers",
    policy:     "Policies and house rules",
    arrival:    "Check-in, check-out and arrival",
    access:     "Accessibility and special needs",
    safety:     "Safety, health and practicalities",
    travel:     "Getting here and getting around",
    nearby:     "Nearby places",
    weather:    "Weather, seasons and packing",
    vouchers:   "Gift vouchers",
    occasions:  "Occasions and groups",
    estate:     "The estate, history and awards",
    contact:    "Contact and the desk",
    planning:   "Trip planning and comparisons"
  };

  root.MM_MEDIA      = { pics: PIC, sets: SETS, cdn: CDN };
  root.MM_PLACES     = PLACES;
  root.MM_MAPS       = { search: mapsSearch, directions: mapsDirections };
  root.MM_QA         = QA;
  root.MM_CATEGORIES = CATEGORIES;

  /* The blocks in misty_knowledge_qa.js push onto this. Keeping the corpus in
     its own file keeps both files a readable size. */
  root.MM_QA_PUSH = function (rows) {
    for (var i = 0; i < rows.length; i++) QA.push(rows[i]);
    return QA.length;
  };

})(typeof window !== "undefined" ? window : globalThis);
