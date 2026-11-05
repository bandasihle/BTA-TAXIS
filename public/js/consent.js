// The location notice drivers accept before their phone shares GPS (POPIA). The server
// checks that a driver accepted this exact version; change the version whenever the text
// changes, and every driver is asked again.

export const CONSENT_VERSION = '2026-11-v1';

export const CONSENT_NOTICE = [
  ['Who is asking', 'The Benoni Taxi Association runs Danki Driver and is responsible for this information.'],
  ['What is collected', 'Your phone\'s GPS position and how accurate it is, while you have sharing switched on in this screen. Nothing else from your phone.'],
  ['Why', 'So passengers and the association can see where taxis on a trip are, how far away they are, and when a taxi has arrived at a rank.'],
  ['Who sees it', 'Passengers see a dot for your taxi (by number plate, never your name) only while it is driving a route. Association staff see the same. It is not sold or given to anyone else.'],
  ['How long it is kept', 'Only your latest position is kept, never a history of where you went. It is deleted when your taxi arrives at a rank, goes off duty, or stops sending for 10 minutes.'],
  ['When it is shared', 'Only while sharing is switched on here and your taxi is on a trip. You can switch it off at any time with the Stop button.'],
  ['Your rights', 'You can withdraw this consent at any time on this screen; your position is deleted straight away. You can ask the association what information it holds about you, ask for it to be corrected or deleted, and complain to the Information Regulator (inforegulator.org.za).'],
];
