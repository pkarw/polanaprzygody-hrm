# Patient — kalendarz wizyt i kontrola dostępności

**Date**: 2026-09-30
**Status**: Draft — szkielet, brama Open Questions otwarta
**Spec ID**: VCAL
**Zakres**: projekt, bez implementacji.
**Zależność**: [VIS — wizyty pacjenta](2026-09-29-patient-visits.md) (ten sam moduł `patient`), która sama zależy od [PAT](2026-09-29-patient-ehr-base.md) faza PAT-1.

> Szkielet wg `om-spec-writing`: TLDR + sekcje kluczowe dla architektury + numerowana brama **Open Questions**. Pozostałe sekcje szablonu `SPEC-000-template.md` powstają dopiero po odpowiedziach — pisanie ich teraz oznaczałoby przepisanie modelu danych, API i faz.

## TLDR

Wizyty (VIS) mają dziś listę i formularz. VCAL dokłada **widok kalendarza** w module `patient` — te same rekordy `patient:patient_visit` pokazane w siatce dzień/tydzień/miesiąc/agenda, z tworzeniem wizyty przez kliknięcie w wolny slot i edycją przez kliknięcie w wizytę — oraz **kontrolę dostępności** wykonawcy i gabinetu, egzekwowaną w komendzie, a więc obowiązującą tak samo dla kalendarza, jak i dla istniejącego formularza z listy wizyt. Kalendarz da się zawęzić do jednego terapeuty.

Nie budujemy własnego silnika dostępności. Platforma już go ma i VCAL go **czyta**:

- `planner:planner_availability_rule` (`subject_type` = `member` \| `resource` \| `ruleset`, `rrule` + `exdates`, `kind` = `availability` \| `unavailability`) — reguły dostępności osoby i zasobu;
- **zaakceptowany wniosek urlopowy `staff:staff_leave_request` sam tworzy reguły `kind='unavailability'` dla `subject_type='member'`** (`staff/commands/leave-requests.ts`, `createUnavailabilityRules`), z `unavailability_reason_value` — czyli urlop i zwolnienie są już w tym samym strumieniu danych, co grafik;
- `resources:resources_resource.availability_rule_set_id` + `is_active` — dostępność gabinetu przez zestaw reguł;
- `plannerAvailabilityService.getMergedAvailabilityWindows({ rules, range })` (DI, `planner/lib/availabilityMerge.ts`) — scalanie okien dostępności minus niedostępności; jedno źródło prawdy dla UI i dla walidacji serwerowej.

Dlatego VCAL nie dodaje ani jednej tabeli grafiku. Dodaje: odczytowe API `availability` w module `patient`, sprawdzenie w komendach zapisu wizyty, powierzchnię kalendarza i (zależnie od Q2) pola audytu świadomego nadpisania konfliktu.

## Problem Statement

1. Rejestracja planuje w siatce godzin, nie w tabeli. Lista wizyt VIS pokazuje wiersze; nie widać z niej dziury w grafiku ani nakładających się terminów, więc planista i tak trzyma drugi kalendarz obok systemu.
2. VIS jawnie wpisała „nakładające się wizyty” i „silnik dostępności” w non-goals, z ryzykiem *„Planista sprawdza grafik ręcznie”*. Brief zamyka dokładnie to ryzyko: wizyta nie ma powstać dla osoby na urlopie/zwolnieniu ani w zajętym gabinecie.
3. Sprawdzenie musi działać **też z listy wizyt**, nie tylko z kalendarza — więc jego miejscem jest komenda zapisu, a nie komponent kalendarza. Kalendarz pokazuje ten sam wynik wcześniej, jako podpowiedź.
4. Dane dostępności już istnieją i są utrzymywane w `staff`/`resources`/`planner`, ale moduł `patient` ich dziś nie czyta, więc wiedza organizacji o urlopach nie dociera do momentu planowania wizyty.

Źródło: brief użytkownika 2026-09-30 + zrzut kalendarza CRM (`/backend/calendar`) jako referencja wizualna.

## Overview and Success Measures

- **Primary outcome:** planista widzi grafik wybranego terapeuty i zakłada w nim wizytę bez opuszczania widoku; zapis wizyty kolidującej z urlopem/zwolnieniem wykonawcy albo z niedostępnym gabinetem nie przechodzi po cichu.
- **Leading indicators:** odsetek wizyt zakładanych z kalendarza; liczba wykrytych kolizji na 100 zapisów; zero zapisów kolidujących bez zarejestrowanej decyzji operatora (zależnie od Q2 — odmowa albo jawne nadpisanie z powodem).
- **Baseline:** VIS nie jest jeszcze zaimplementowana; dziś nie ma ani kalendarza, ani kontroli kolizji. Baseline = 0.
- **Market / product reference:** do uzupełnienia po bramie — kandydaci to OpenEMR (scheduling z blokadą slotu) i Cal.com (model availability = reguły + wyjątki, ten sam kształt co `planner`).

## Reuse and Ownership Map (wstępny — to on wymusza pytania poniżej)

**Installed-version:** `0.8.1-develop.7266.1.8e520bbe03` (zgodnie z VIS).

| Zdolność | Właściciel / źródło | Sposób powiązania |
|---|---|---|
| Rekord wizyty | VIS `patient:patient_visit` | Bez zmiany modelu (poza ewentualnym audytem nadpisania — Q2) |
| Dostępność osoby | `planner:planner_availability_rule`, `subject_type='member'`, `subject_id = staff_team_member.id` | Odczyt `GET /api/planner/availability` + `plannerAvailabilityService` |
| Urlop / zwolnienie | `staff:staff_leave_request` → reguły `kind='unavailability'` tworzone przy akceptacji | **Nie czytamy tabeli wniosków**; czytamy reguły, więc „pending” wniosek z definicji nie blokuje |
| Dostępność gabinetu | `resources:resources_resource` (`is_active`, `availability_rule_set_id`) + reguły `subject_type='resource'`/`'ruleset'` | Odczyt + scalanie tą samą funkcją |
| Siatka kalendarza | `@open-mercato/ui/backend/schedule` — `ScheduleView` (`day`/`week`/`month`/`agenda`, `onSlotClick`, `onItemClick`, `ScheduleItem`) | Używana już przez `planner`, `staff`, `resources`; alternatywa `customers/components/calendar/*` — patrz Q4 |
| Wzorzec ostrzeżenia o kolizji | `customers/lib/calendar/conflicts.ts` (`findConflicts`, `findEditorConflictItems`) | Precedens: CRM **ostrzega** spójnie w siatce i w edytorze, nie blokuje |
| Uprawnienia hostów | `planner.view`, `resources.view`, `staff.view` | Sprawdzenie dostępności nie może omijać ACL modułów-właścicieli |

Wnioski, które ta mapa już przesądza i które **nie** są przedmiotem pytań: żadnej nowej tabeli grafiku, żadnej relacji ORM między modułami (tylko skalarne ID + odczyt przez API/DI), żadnego duplikowania urlopów w `patient`.

## Open Questions (brama — odpowiedzi przed dalszym pisaniem)

| ID | Pytanie | Dlaczego blokuje |
|---|---|---|
| **Q1** | Czy to jedna specyfikacja, czy dwie: (a) kalendarz wizyt, (b) kontrola dostępności przy zapisie wizyty? Każda działa bez drugiej — kontrola obowiązuje też formularz z listy, a kalendarz działa bez kontroli. | `om-spec-writing` wymaga podniesienia podziału, gdy brief łączy dwie niezależnie wdrażalne zdolności. Decyzja zmienia liczbę dokumentów, kolejność faz i granice PR-ów. |
| **Q2** | Kolizja (wykonawca na urlopie/zwolnieniu, poza grafikiem, gabinet niedostępny lub zajęty) = **twarda odmowa zapisu** czy **ostrzeżenie z jawnym nadpisaniem i powodem**? | Zmienia model danych (pola audytu nadpisania), kontrakt API (422 vs 200 + `overrideReason`), UI formularza i komplet testów. Precedens CRM ostrzega; brief mówi „sprawdzenie”. |
| **Q3** | Co znaczy „zajęty”? (a) tylko reguły dostępności `planner`; (b) także **inna wizyta** tego terapeuty/gabinetu w tym czasie (podwójna rezerwacja); (c) dodatkowo wydarzenia z kalendarza CRM (`customers`) rezerwujące tę samą osobę/gabinet. | Wyznacza zakres zapytań, indeksy, koszt sprawdzenia i to, czy `patient` zaczyna czytać dane CRM. |
| **Q4** | Komponent kalendarza: współdzielony **`ScheduleView`** z `@open-mercato/ui/backend/schedule` (prymityw design systemu, dzień/tydzień/miesiąc/agenda, używany przez `planner`/`staff`/`resources`), czy odtworzenie ekranu CRM `customers/components/calendar/CalendarScreen` (zrzut z briefu — zakładki, filtry, popover, skróty)? | Ekran CRM jest wewnętrzny dla modułu `customers` i **nie jest publicznym kontraktem** — import spoza modułu wiąże `patient` z prywatną powierzchnią; `ScheduleView` jest wspierany, ale uboższy (bez zakładek kategorii i popoveru podglądu). Decyzja przesądza architekturę UI i to, co trzeba napisać samodzielnie. |

Założenie przyjęte bez pytania (do odrzucenia, jeśli błędne): VCAL zakłada dostarczoną fazę VIS-1; nie scalamy go z VIS, bo VIS jest zamknięta przeglądem i ma własne fazy.

## Dalsze sekcje

Pozostałe sekcje szablonu (`Goals`, `Non-goals`, `Proposed Solution`, `Domain Vocabulary`, `Users/Permissions`, `Architecture`, `User Journeys`, `UI and Interaction Contracts`, `Data Models`, `API/Command/Error Contracts`, `Events`, `Security`, `Integration Coverage`, `Implementation Phases`, `Requirement Traceability`, `Rollout`, `Risks`, `Acceptance Criteria`, `Final Compliance Report`) — **do napisania po zamknięciu bramy.** Makiety graficzne ekranów powstaną w `assets/` w tym samym kroku, bo ich układ zależy od Q2 i Q4.

## Changelog

| Date | Change |
|---|---|
| 2026-09-30 | Szkielet VCAL: TLDR, problem, miary, mapa reuse z ustaleniem, że dostępność ma już silnik w `planner` + `staff` + `resources`; brama Open Questions Q1–Q4 |
