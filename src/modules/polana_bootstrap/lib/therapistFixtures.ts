// These profiles were originally captured from the clinic's public team page. The names,
// photos and any third-party names mentioned in the bios below have been replaced with
// fictional placeholders so this repository does not carry real staff personal data in
// version control (GDPR). The professional shape of each profile — role, experience,
// specializations — is kept so the bootstrap fixtures still exercise the real data model.
export const POLANA_THERAPISTS_SOURCE_URL = 'https://polanaprzygody.pl/terapeuci'
export const POLANA_THERAPISTS_CAPTURED_AT = '2026-09-28'

export type PolanaTherapistFixture = {
  sourceId: string
  displayName: string
  roles: string[]
  experience: string
  photoUrl: string
  shortDescription: string
  fullDescription: string
  quote: string
  specializations: string[]
  bookingUrl: string
}

export const POLANA_THERAPIST_TEAM = {
  name: 'Terapeuci Polany Przygody',
  description: 'Zespół specjalistów Centrum Rozwoju Dziecka Polana Przygody.',
} as const

export const POLANA_THERAPISTS: readonly PolanaTherapistFixture[] = [
  {
    sourceId: 'elzbieta-sokolowska',
    displayName: 'Elżbieta Sokołowska',
    roles: ['Założycielka', 'Logopeda'],
    experience: 'Logopeda od 12 lat',
    photoUrl: 'https://ui-avatars.com/api/?name=Elzbieta+Sokolowska&background=0D8ABC&color=fff',
    shortDescription: 'Logopeda od 12 lat. W mojej pracy najważniejszy jest indywidualny plan pracy, bo każde dziecko ma inne potrzeby.',
    fullDescription: 'Ukończyłam studia na Uniwersytecie Wrocławskim, 12 lat temu. Doświadczenie zdobywałam pracując w przedszkolach, mając pod swoją opieką 250 dzieci co roku.\n\nTaka duża ilość dzieci przez wiele lat pokazała mi zróżnicowanie potrzeb i pomogła dokształcać się w wielu dziedzinach. Od dyslalii, dyspraksji, opóźnionego rozwoju mowy, afazji, autyzmu, mutyzmu wybiórczego i wiele innych wyzwań które pomogło mi się rozwinąć a przede wszystkim pomogło dzieciom.\n\nUkończone mam również studia z edukacji muzycznej, elementy muzykoterapii w terapii logopedycznej pięknie wspomagają rozwój mowy.\n\nPrywatnie mama dwójki dzieci ❤️',
    quote: 'W mojej pracy najważniejszy jest indywidualny plan pracy, bo każde dziecko ma inne potrzeby.',
    specializations: ['Dyslalia', 'Dyspraksja', 'Opóźniony rozwój mowy', 'Afazja', 'Autyzm', 'Mutyzm wybiórczy', 'Muzykoterapia w logopedii'],
    bookingUrl: 'https://polanaprzygody.pl/umow-sie?subject=terapia-logopedyczna#formularz-kontaktowy',
  },
  {
    sourceId: 'joanna-wieczorek',
    displayName: 'Joanna Wieczorek',
    roles: ['Terapeuta Integracji Sensorycznej'],
    experience: '14 lat doświadczenia',
    photoUrl: 'https://ui-avatars.com/api/?name=Joanna+Wieczorek&background=6D28D9&color=fff',
    shortDescription: 'Sympatyczna i zawsze uśmiechnięta terapeutka z 14-letnim doświadczeniem w pracy z dziećmi. Od kilku lat zajmuje się integracją sensoryczną, wspierając najmłodszych w budowaniu równowagi, rozwoju i pewności siebie. W swojej pracy łączy indywidualne podejście z ciepłą, pełną zrozumienia atmosferą.',
    fullDescription: 'Stale poszerza swoją wiedzę, uczestnicząc w licznych szkoleniach i kursach prowadzonych przez uznanych specjalistów integracji sensorycznej. Jest również trenerem Treningu Umiejętności Społecznych oraz terapeutą biofeedback, co pozwala jej jeszcze skuteczniej wspierać dzieci w rozwoju emocjonalnym, poznawczym i sensorycznym.',
    quote: 'Terapia SI to dla mnie zabawa z sensem!',
    specializations: ['Diagnoza i terapia SI', 'Trudności w koncentracji', 'Koordynacja ruchowa', 'Trening Umiejętności Społecznych', 'Biofeedback'],
    bookingUrl: 'https://polanaprzygody.pl/umow-sie?subject=terapia-si#formularz-kontaktowy',
  },
  {
    sourceId: 'aleksandra-nowakowska',
    displayName: 'Aleksandra Nowakowska',
    roles: ['Logopeda', 'Neurologopeda'],
    experience: 'Logopeda i Neurologopeda',
    photoUrl: 'https://ui-avatars.com/api/?name=Aleksandra+Nowakowska&background=047857&color=fff',
    shortDescription: 'Jestem logopedą i neurologopedą, który nieustannie poszerza swoją wiedzę między innymi studiując logopedię kliniczną oraz uczestnicząc w licznych szkoleniach, kursach i konferencjach logopedycznych.',
    fullDescription: 'Pozwala mi to jeszcze lepiej zgłębiać zagadnienia związane z diagnozą i terapią zaburzeń mowy oraz komunikacji, a także oferować wsparcie zgodne z najnowszą wiedzą i aktualnymi standardami.\n\nW swojej pracy prowadzę terapię miofunkcjonalną, która jest ważnym elementem mojej pracy. Skupiam się na prawidłowej pracy mięśni twarzy, języka i całego aparatu artykulacyjnego, aby wspierać dzieci w osiąganiu harmonijnego i prawidłowego rozwoju funkcji prymarnych, takich jak oddychanie, żucie, połykanie czy mowa.\n\nPraca z dziećmi jest moją pasją. W terapii stawiam na indywidualne podejście, uważność i budowanie relacji opartej na zaufaniu.\n\nJestem osobą ciepłą i zaangażowaną, a w swojej pracy dbam o to, by każde dziecko czuło się bezpiecznie i mogło rozwijać swój potencjał w swoim tempie.\n\nPrywatnie jestem mamą trzech wspaniałych dziewczynek ❤️',
    quote: 'W terapii stawiam na indywidualne podejście, uważność i budowanie relacji opartej na zaufaniu.',
    specializations: ['Logopedia kliniczna', 'Terapia miofunkcjonalna', 'Diagnoza zaburzeń mowy', 'Terapia zaburzeń komunikacji'],
    bookingUrl: 'https://polanaprzygody.pl/umow-sie?subject=terapia-logopedyczna#formularz-kontaktowy',
  },
  {
    sourceId: 'barbara-kowalczyk',
    displayName: 'Barbara Kowalczyk',
    roles: ['Psycholożka', 'Psychoterapeutka w trakcie szkolenia'],
    experience: '20 lat doświadczenia',
    photoUrl: 'https://ui-avatars.com/api/?name=Barbara+Kowalczyk&background=B45309&color=fff',
    shortDescription: 'Psycholożka i psychoterapeutka dzieci, młodzieży i rodzin. Prowadzi psychoterapię indywidualną, rodzinną oraz konsultacje dla rodziców. Pracuje w podejściu systemowym i poznawczo-behawioralnym.',
    fullDescription: 'Ukończyłam psychologię na Uniwersytecie im. Adama Mickiewicza w Poznaniu. Szkolenie z terapii poznawczo-behawioralnej dzieci i młodzieży odbyłam w Szkole Psychoterapii Centrum CBT w Warszawie. Ukończyłam 3-stopniowe szkolenie z terapii behawioralnej zakończone Certyfikatem Nauczyciela-Terapeuty dziecka z autyzmem w Instytucie Wspomagania Rozwoju Dziecka w Gdańsku. Obecnie uczestniczę w Całościowym Kursie Psychoterapii w nurcie systemowo-eriksonowskim (IV rok szkolenia) we Wrocławskim Instytucie Psychoterapii.\n\nJestem certyfikowaną trenerką Treningu Umiejętności Społecznych oraz kotrenerem Treningu Zastępowania Agresji (ART). Ukończyłam studia podyplomowe z neurologopedii oraz kurs terapii integracji sensorycznej, posiadam także kwalifikacje w zakresie wczesnego wspomagania rozwoju dziecka.\n\nW pracy diagnostycznej i terapeutycznej wspieram dzieci i młodzież z trudnościami wychowawczymi, zaburzeniami lękowymi, depresyjnymi, psychosomatycznymi, zaburzeniami odżywiania oraz z diagnozą ASD i ADHD. Współpraca z rodziną jest dla mnie kluczowa, a swoją pracę poddaję stałej superwizji i prowadzę zgodnie z kodeksem etycznym Polskiego Towarzystwa Psychologicznego.',
    quote: 'Współpraca z rodziną to klucz do skutecznej terapii.',
    specializations: ['Psychoterapia dzieci i młodzieży', 'Psychoterapia rodzinna', 'Diagnoza psychologiczna', 'Terapia poznawczo-behawioralna', 'Podejście systemowe', 'Integracja sensoryczna (SI)', 'ASD i ADHD', 'Zaburzenia lękowe i nastroju'],
    bookingUrl: 'https://polanaprzygody.pl/umow-sie?subject=konsultacja-psychologiczna#formularz-kontaktowy',
  },
] as const
