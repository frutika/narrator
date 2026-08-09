# Narrator

Lokalni alat za naraciju preko videa. Azure Neural TTS za glas, ffmpeg za miks.
Nema npm ovisnosti — samo Node 18+ i ffmpeg.

## Postavljanje

**1. Azure Speech resurs.** Treba ti vlastiti u Azure portalu (Speech service).
Besplatni **F0** sloj daje 500 000 znakova mjesečno za neuralne glasove, što je
za naraciju i više nego dovoljno.

F0 ima i limit od **20 zahtjeva u 60 sekundi**. Projekt s više linija od toga
alat rješava sam — na `429` pričeka koliko Azure traži i nastavi, do 5 pokušaja
po liniji. U konzoli vidiš kad se to dogodi.

**2. Ključ i regija.** Postavi ih kao varijable okoline — ključ tako nikad ne
završi u datoteci:

```
setx AZURE_SPEECH_KEY "tvoj-kljuc"
setx AZURE_SPEECH_REGION "northeurope"
```

Regija mora biti točno onakva kakvu Azure koristi u URL-u — malim slovima, bez
razmaka (`northeurope`, `westeurope`…). Portal je prikazuje kao „North Europe",
a to API ne prihvaća. Kriva regija daje `401`, koji izgleda kao problem s ključem.

Otvori novi terminal da ih pokupi. Alternativa je `config.json` u ovom folderu
(`{ "azureKey": "...", "azureRegion": "westeurope" }`) — već je u `.gitignore`.

**3. Pokretanje.** Dvoklik na `start.cmd`, ili:

```bash
node server.js
```

Otvori `http://localhost:4173`.

## Kako se koristi

1. **Video** — zalijepi punu putanju, klikni Učitaj. Pročita trajanje i javi ima
   li zvučni zapis.
2. **Glas** — odaberi jezik pa glas. Glasovi označeni ★ podržavaju stilove
   (`cheerful`, `sad`, `newscast`, `calm`…). Tempo i visina su postotna odstupanja.
3. **Linije** — jedna rečenica ili misao po liniji. `⚙` otvara pregaženja za tu
   liniju: drugi glas, drugi stil, drugi tempo. **Tu se radi višeglasje** — dvije
   linije s različitim glasom daju dijalog.
4. **Sintetiziraj** — šalje samo izmijenjene linije. Nepromijenjene se čitaju iz
   predmemorije, pa ponovna sinteza ne troši kvotu.
5. **Timing** — „Rasporedi automatski" ravnomjerno posloži linije po trajanju
   videa uz zadani uvod i odjavu. Blokove na timelineu možeš povući mišem;
   crveni blok znači preklapanje s idućom linijom ili sa zabranjenom zonom.

   **„Skeniraj original"** pronalazi mjesta gdje video **već ima govor** i
   označi ih crveno na timelineu. Raspoređivanje ih zaobilazi — original uvijek
   ima prednost. „Razmak od zona" je zaštitni pojas sa svake strane (zadano
   0.6 s). Ako detekcija promaši, zone su obični brojevi u `project.json` pod
   `blocked`, pa se mogu dopisati ručno.
6. **Titlovi** — dva odvojena pojma, namjerno se ne miješaju:

   - **izgovoreni tekst** uzima cijelu rečenicu iz linije. To je ono što ide na
     YouTube kao titlovi, pa mora odgovarati zvuku — i zbog pristupačnosti i
     zbog YouTubeovih pravila.
   - **kratki naslovi** uzimaju polje „Naslov na ekranu" pod `⚙`. Linija bez
     naslova tada ne prikazuje ništa, pa se natpisi mogu staviti samo gdje
     imaju smisla.

   Naslov nije dio hasha za predmemoriju, pa njegova izmjena **ne troši Azure
   kvotu**.

   **„Jezik teksta" nije isto što i glas.** Alat ne prevodi pri izvozu — titlovi
   sadrže linije onakve kakve jesu. Zato jezik biraš sam. Dok se izvodio iz
   glasa, odabir hrvatskog glasa na engleskom projektu davao je datoteku
   `.hr_HR.srt` **punu engleskog teksta**, koju bi YouTube i Facebook
   posluživali kao hrvatske titlove. Ako se glas i jezik teksta ne poklapaju,
   alat to sada javi.

   **Imenovanje `.srt` datoteke nije kozmetika.** Facebook prihvaća titlove samo
   ako se datoteka zove `naziv.jezik_DRŽAVA.srt` — mala slova za jezik, velika za
   državu (`lumenta-labs-iris.en_US.srt`). Krivo ime i upload se odbija bez
   objašnjenja. Alat lokal izvodi iz odabranog glasa, pa isto ime radi i na
   YouTubeu, koji na naziv ne obraća pažnju.

7. **Miks i render** — podloga se automatski spušta ispod glasa. Render kopira
   video zapis bez rekodiranja, pa je brz i ne gubi kvalitetu slike.

   **Iznimka: „Upiši u sliku".** Crtanje teksta u sliku onemogućuje kopiranje
   zapisa, pa se video ponovno kodira (libx264, CRF 18). Render traje bitno duže
   i slika se blago degradira. Ako ti titlovi trebaju samo za YouTube, ostavi to
   isključeno i koristi `.srt` — slika ostaje netaknuta.

Projekt se sprema u `projects/<naziv>/` (`project.json` + `wav/`) i autosprema
svakih 15 sekundi.

## Druga jezična verzija

1. **„Nova jezična verzija"** kopira projekt s istim timingom, zonama i
   strukturom. **Zvuk se namjerno ne kopira** — inače bi stari jezik tiho ostao
   u miksu.
2. **„Prevedi automatski"** prevede sve linije i naslove na odabrani jezik
   teksta. Prevedene linije dobiju oznaku **„strojni nacrt"** koja nestane čim
   ih ručno dotakneš.
3. Odaberi glas za taj jezik, pa **Sintetiziraj**.
4. **„Rasporedi automatski"** — trajanje izgovora razlikuje se po jeziku, pa
   stari timing više ne odgovara.

### Zaštićeni pojmovi

Polje **„Ne prevodi"** drži nazive koje prevoditelj ne smije dirati. Bez njega
Azure „The Dog Habit" pretvori u „Navika psa", a „Unmasked Words" u „Otkrivene
riječi" — izmjereno, ne pretpostavljeno. Alat te pojmove šalje kroz Azureov
dynamic dictionary, pa izlaze doslovno onakvi kakve si ih upisao.

Zadano su tu svi tvoji brendovi. Dodaj svaki novi naziv prije prvog prijevoda.

### Strojni prijevod je nacrt, ne isporuka

Nazivi su riješeni, ali **idiomi nisu**. Izmjereno na tvom scenariju:

| Original | Strojno HR | Strojno DE |
|---|---|---|
| „We run on it" | „Radimo na tome" | „Wir laufen darauf" |

Prvo znači „još radimo na tome". Drugo doslovno „hodamo po tome". Rečenica koja
nosi cijeli dokaz postala je besmislena na oba jezika.

Zato prevedene linije nose oznaku **„strojni nacrt"** koja nestane tek kad ih
ručno dotakneš. Pročitaj ih prije sinteze — posebno rečenice koje nose poantu.

### Ključ za prevoditelj

Translator je **zaseban Azure resurs** od Speecha, s vlastitim ključem.
Besplatni **F0** sloj daje **2 milijuna znakova mjesečno** — scenarij od tri
minute troši oko dvije tisuće.

Azure portal → Create a resource → **Translator** → Free F0. Zatim:

```
setx AZURE_TRANSLATOR_KEY "tvoj-kljuc"
setx AZURE_TRANSLATOR_REGION "northeurope"
```

Regija se, ako je ne postaviš, preuzima od Speecha. Bez ključa je gumb
„Prevedi automatski" onemogućen, a sve ostalo radi normalno.

## Spuštanje podloge

Izmjereno na stvarnom materijalu, ne procijenjeno:

| Postavka | Koliko padne podloga |
|---|---|
| blago | ~6 dB |
| srednje | ~10 dB |
| jako | ~14 dB |
| maksimalno | ~18 dB |

Srednje je dobra zadana vrijednost: glas je jasno iznad, a podloga se i dalje
čuje. Maksimalno praktički ugasi glazbu dok netko govori.

Detektor duckinga ima **vlastito fiksno pojačanje** (`volume=4.0` u
`buildFilter`), odvojeno od klizača „Glasnoća naracije". Zato dubina duckinga
ostaje ista bez obzira koristiš li glasan neuralni glas ili tihu vlastitu
snimku. Ako mijenjaš to pojačanje, gornja tablica više ne vrijedi — treba je
ponovno izmjeriti.

## Kako detekcija govora radi

Voiceover se gotovo uvijek miksa u centar, a glazba je široka. Alat zato razdvoji
mid (L+R) i side (L−R) kanal, propusti oba kroz govorni pojas 300–3400 Hz i
traži prozore u kojima mid nadvisuje side puno više nego inače. To pouzdano
razlikuje govor od glazbe bez ikakvog prepoznavanja riječi.

Ako je zvuk **mono**, side kanal je prazan i metoda ne radi — alat to javi
umjesto da označi cijeli video kao govor. U tom slučaju zone se upisuju ručno.

## Ograničenja

- Render traži da naracija stane u trajanje videa. Ako ne stane, alat to javi
  prije rendera umjesto da odreže kraj.
- Video zapis se kopira, ne rekodira — izlazni format prati ulazni.
- Ako video nema zvuk, „Zadrži originalni zvuk" se sam isključi.
