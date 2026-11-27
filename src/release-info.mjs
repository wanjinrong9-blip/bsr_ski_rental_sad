// Public project facts. Experience membership does not authorize a business
// session, attest an official code, or prove a particular phone can connect.
export function publicReleaseInfo({miniBackendEnabled=false,officialEntryStatus='off'}={}){
  return {
    codeVersion:'0.1.2',requirementsBaseline:'4.14',
    miniExperience:{access:'MEMBERS_ENABLED',reportedAt:'2026-11-27',evidence:'OWNER_REPORTED'},
    miniBackend:{configured:miniBackendEnabled===true},
    officialMiniEntry:{status:['off','paused','ready'].includes(officialEntryStatus)?officialEntryStatus:'off'}
  };
}
