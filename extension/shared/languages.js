// Caption languages and the code each platform uses for them:
//   zoom  - numeric id Zoom's web client sends in its caption-language message
//   teams - locale passed to the Teams call's setClosedCaptionsLanguage()
//   meet  - language code Meet's media session takes (the regional codes Meet's own menu uses)
(function (root) {
  const Earshot = (root.Earshot = root.Earshot || {});

  Earshot.LANGUAGES = [
    { id: "en", name: "English", zoom: 0, teams: "en-us", meet: "en-US" },
    { id: "es", name: "Spanish", zoom: 7, teams: "es-es", meet: "es-ES" },
    { id: "fr", name: "French", zoom: 4, teams: "fr-fr", meet: "fr-FR" },
    { id: "de", name: "German", zoom: 3, teams: "de-de", meet: "de-DE" },
    { id: "it", name: "Italian", zoom: 9, teams: "it-it", meet: "it-IT" },
    { id: "pt", name: "Portuguese", zoom: 6, teams: "pt-br", meet: "pt-BR" },
    { id: "nl", name: "Dutch", zoom: 12, teams: "nl-nl", meet: "nl-NL" },
    { id: "sv", name: "Swedish", zoom: 29, teams: "sv-se", meet: "sv-SE" },
    { id: "pl", name: "Polish", zoom: 27, teams: "pl-pl", meet: "pl-PL" },
    { id: "tr", name: "Turkish", zoom: 33, teams: "tr-tr", meet: "tr-TR" },
    { id: "ru", name: "Russian", zoom: 5, teams: "ru-ru", meet: "ru-RU" },
    { id: "uk", name: "Ukrainian", zoom: 13, teams: "uk-ua", meet: "uk-UA" },
    { id: "hi", name: "Hindi", zoom: 22, teams: "hi-in", meet: "hi-IN" },
    { id: "ja", name: "Japanese", zoom: 2, teams: "ja-jp", meet: "ja-JP" },
    { id: "ko", name: "Korean", zoom: 8, teams: "ko-kr", meet: "ko-KR" },
    { id: "zh", name: "Chinese (Simplified)", zoom: 1, teams: "zh-cn", meet: "cmn-Hans-CN" },
    { id: "zh-hant", name: "Chinese (Traditional)", zoom: 16, teams: "zh-tw", meet: "cmn-Hant-TW" },
    { id: "ar", name: "Arabic", zoom: 14, teams: "ar-sa", meet: "ar-EG" },
    { id: "he", name: "Hebrew", zoom: 21, teams: "he-il", meet: "he-IL" },
    { id: "id", name: "Indonesian", zoom: 24, teams: "id-id", meet: "id-ID" },
    { id: "vi", name: "Vietnamese", zoom: 11, teams: "vi-vn", meet: "vi-VN" },
  ];

  Earshot.languageById = (id) => Earshot.LANGUAGES.find((l) => l.id === id) || Earshot.LANGUAGES[0];

  // Map whatever a platform reports back (Zoom id, Teams locale, Meet code) to one of ours.
  Earshot.languageFromPlatform = (platform, value) => {
    if (value === null || value === undefined || value === "") return null;
    const v = String(value).toLowerCase();
    return (
      Earshot.LANGUAGES.find((l) =>
        platform === "zoom" ? String(l.zoom) === v : platform === "teams" ? l.teams === v : String(l.meet).toLowerCase() === v
      ) ||
      // Meet's Chinese codes start "cmn-"; anything else by its first part ("en-GB" -> English).
      (platform === "meet" && /^cmn-hant/.test(v) ? Earshot.languageById("zh-hant") : null) ||
      (platform === "meet" && /^cmn/.test(v) ? Earshot.languageById("zh") : null) ||
      (platform === "meet" && /^iw\b/.test(v) ? Earshot.languageById("he") : null) ||
      Earshot.LANGUAGES.find((l) => v.startsWith(l.id))
    ) || null;
  };
})(typeof self !== "undefined" ? self : window);
