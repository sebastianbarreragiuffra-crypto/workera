const REQUEST_KEY_PREFIX = "WORKERA_MEAL_FORM_";
const EXPIRATION_REGISTRY_KEY = "WORKERA_MEAL_FORM_EXPIRATIONS";

function doPost(event) {
  try {
    const request = JSON.parse(event && event.postData ? event.postData.contents : "{}");
    const expectedSecret = PropertiesService.getScriptProperties().getProperty("WORKERA_SHARED_SECRET");
    if (!expectedSecret || request.secret !== expectedSecret) return jsonResponse_({ ok: false, error: "No autorizado." });

    if (request.operation === "list") return jsonResponse_({ ok: true, version: 8, forms: listStoredForms_() });
    if (request.operation === "status") return jsonResponse_({ ok: true, status: getFormStatus_(request.formId) });

    const payload = validatePayload_(request.payload);
    const propertyKey = REQUEST_KEY_PREFIX + payload.requestId;
    const properties = PropertiesService.getScriptProperties();
    const cached = properties.getProperty(propertyKey);
    if (cached) {
      const existing = upgradeStoredForm_(JSON.parse(cached), payload);
      formatSupplierWorkbook_(existing.responseSheetUrl, payload.questions.length);
      properties.setProperty(propertyKey, JSON.stringify(existing));
      return jsonResponse_({ ok: true, form: Object.assign(existing, { reused: true }) });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const lockedCached = properties.getProperty(propertyKey);
      if (lockedCached) {
        const existing = upgradeStoredForm_(JSON.parse(lockedCached), payload);
        formatSupplierWorkbook_(existing.responseSheetUrl, payload.questions.length);
        properties.setProperty(propertyKey, JSON.stringify(existing));
        return jsonResponse_({ ok: true, form: Object.assign(existing, { reused: true }) });
      }

      const form = FormApp.create(payload.title);
      form.setDescription(payload.description);
      form.setCollectEmail(true);
      form.setConfirmationMessage("Tu elección de colaciones fue registrada correctamente.");
      form.addListItem().setTitle("Nombre y apellido").setChoiceValues(payload.employeeNames).setRequired(true);

      payload.questions.forEach(function (question) {
        form.addMultipleChoiceItem()
          .setTitle(question.title)
          .setChoiceValues(question.options)
          .setRequired(true);
      });

      const responseSheet = SpreadsheetApp.create(payload.title + " - RESPUESTAS");
      form.setDestination(FormApp.DestinationType.SPREADSHEET, responseSheet.getId());
      formatSupplierWorkbook_(responseSheet.getUrl(), payload.questions.length);
      registerExpiration_(form.getId(), payload.closeAtLocal);
      ensureExpirationTrigger_();

      const result = {
        formId: form.getId(),
        title: payload.title,
        responderUrl: form.getPublishedUrl(),
        editUrl: form.getEditUrl(),
        responseSheetUrl: responseSheet.getUrl(),
        responseSheetDownloadUrl: buildSpreadsheetDownloadUrl_(responseSheet.getId()),
        closeAtLocal: payload.closeAtLocal,
        reminderAfterHours: payload.reminderAfterHours,
        createdAt: new Date().toISOString(),
        dayLabels: payload.questions.map(function (question) { return question.title; }),
        omittedDays: payload.omittedDays || [],
        reused: false,
      };
      properties.setProperty(propertyKey, JSON.stringify(result));
      return jsonResponse_({ ok: true, form: result });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return jsonResponse_({ ok: false, error: error && error.message ? error.message : "No se pudo crear el formulario." });
  }
}

function listStoredForms_() {
  const properties = PropertiesService.getScriptProperties();
  const allProperties = properties.getProperties();
  const registry = JSON.parse(properties.getProperty(EXPIRATION_REGISTRY_KEY) || "{}");
  const forms = Object.keys(allProperties).filter(function (key) {
    return key !== EXPIRATION_REGISTRY_KEY && key.indexOf(REQUEST_KEY_PREFIX) === 0;
  }).map(function (key) {
    const stored = JSON.parse(allProperties[key]);
    if (!stored.title && stored.formId) {
      try {
        stored.title = FormApp.openById(stored.formId).getTitle();
      } catch (_) {
        try {
          stored.title = SpreadsheetApp.openById(extractSpreadsheetId_(stored.responseSheetUrl)).getName().replace(/\s+-\s+RESPUESTAS$/i, "");
        } catch (_) {
          stored.title = "Formulario de colaciones";
        }
      }
    }
    stored.closeAtLocal = stored.closeAtLocal || registry[stored.formId] || "";
    stored.reminderAfterHours = Number.isInteger(stored.reminderAfterHours) ? stored.reminderAfterHours : 24;
    stored.responseSheetDownloadUrl = stored.responseSheetDownloadUrl || buildSpreadsheetDownloadUrl_(extractSpreadsheetId_(stored.responseSheetUrl));
    stored.createdAt = stored.createdAt || "";
    stored.dayLabels = Array.isArray(stored.dayLabels) ? stored.dayLabels : [];
    stored.omittedDays = Array.isArray(stored.omittedDays) ? stored.omittedDays : [];
    stored.reused = true;
    properties.setProperty(key, JSON.stringify(stored));
    return stored;
  }).filter(function (stored) {
    return Boolean(stored.formId && stored.responderUrl && stored.editUrl && stored.responseSheetUrl && stored.responseSheetDownloadUrl);
  });

  forms.sort(function (a, b) {
    return String(b.createdAt || b.closeAtLocal).localeCompare(String(a.createdAt || a.closeAtLocal));
  });
  return forms.slice(0, 20);
}

function upgradeStoredForm_(stored, payload) {
  stored.title = stored.title || payload.title;
  stored.closeAtLocal = stored.closeAtLocal || payload.closeAtLocal;
  stored.reminderAfterHours = Number.isInteger(stored.reminderAfterHours) ? stored.reminderAfterHours : payload.reminderAfterHours;
  stored.createdAt = stored.createdAt || new Date().toISOString();
  stored.dayLabels = Array.isArray(stored.dayLabels) && stored.dayLabels.length
    ? stored.dayLabels
    : payload.questions.map(function (question) { return question.title; });
  stored.omittedDays = Array.isArray(stored.omittedDays) ? stored.omittedDays : (payload.omittedDays || []);
  stored.responseSheetDownloadUrl = stored.responseSheetDownloadUrl || buildSpreadsheetDownloadUrl_(extractSpreadsheetId_(stored.responseSheetUrl));
  stored.reused = false;
  return stored;
}

function getFormStatus_(formId) {
  if (typeof formId !== "string" || !formId.trim()) throw new Error("El formulario solicitado no es válido.");
  const stored = findStoredFormById_(formId);
  if (!stored) throw new Error("El formulario no pertenece al registro de Workera.");

  const spreadsheetId = extractSpreadsheetId_(stored.responseSheetUrl);
  if (!spreadsheetId) throw new Error("El formulario no tiene una planilla de respuestas válida.");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const responseTab = spreadsheet.getSheets().find(function (sheet) {
    return sheet.getName() === "Pedidos proveedor";
  }) || spreadsheet.getSheets().find(function (sheet) {
    return sheet.getLastColumn() >= 3;
  });
  if (!responseTab) throw new Error("No se encontró la hoja de respuestas del formulario.");

  const lastColumn = responseTab.getLastColumn();
  const headers = lastColumn > 0 ? responseTab.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  let nameColumnIndex = headers.findIndex(function (header) {
    return normalizeText_(header) === "NOMBRE Y APELLIDO";
  });
  if (nameColumnIndex < 0 && lastColumn >= 3) nameColumnIndex = 2;

  const lastRow = responseTab.getLastRow();
  const respondentNames = nameColumnIndex >= 0 && lastRow > 1
    ? responseTab.getRange(2, nameColumnIndex + 1, lastRow - 1, 1).getDisplayValues()
      .map(function (row) { return String(row[0] || "").trim(); })
      .filter(Boolean)
    : [];

  let acceptingResponses = false;
  try { acceptingResponses = FormApp.openById(formId).isAcceptingResponses(); } catch (_) { acceptingResponses = false; }

  return {
    formId: formId,
    respondentNames: respondentNames,
    responseCount: respondentNames.length,
    acceptingResponses: acceptingResponses,
    updatedAt: new Date().toISOString(),
  };
}

function findStoredFormById_(formId) {
  const allProperties = PropertiesService.getScriptProperties().getProperties();
  const keys = Object.keys(allProperties).filter(function (key) {
    return key !== EXPIRATION_REGISTRY_KEY && key.indexOf(REQUEST_KEY_PREFIX) === 0;
  });
  for (let index = 0; index < keys.length; index += 1) {
    const stored = JSON.parse(allProperties[keys[index]]);
    if (stored.formId === formId) return stored;
  }
  return null;
}

function normalizeText_(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ").toUpperCase();
}

function formatSupplierWorkbook_(spreadsheetUrl, questionCount) {
  let step = "abrir la planilla";
  try {
    const spreadsheetId = extractSpreadsheetId_(spreadsheetUrl);
    if (!spreadsheetId) throw new Error("No se pudo identificar la planilla de respuestas.");
    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    spreadsheet.setSpreadsheetLocale("es_CL");

    step = "encontrar la hoja de respuestas";
    let responseTab = null;
    for (let attempt = 0; attempt < 12 && !responseTab; attempt += 1) {
      SpreadsheetApp.flush();
      const sheets = spreadsheet.getSheets();
      responseTab = sheets.find(function (sheet) { return sheet.getLastColumn() >= 3; }) || null;
      if (!responseTab) Utilities.sleep(250);
    }
    if (!responseTab) throw new Error("Google no alcanzó a preparar la hoja de respuestas.");

    step = "eliminar hojas vacías";
    const sheets = spreadsheet.getSheets();
    sheets.forEach(function (sheet) {
      if (sheet.getSheetId() !== responseTab.getSheetId() && sheet.getLastRow() === 0 && spreadsheet.getSheets().length > 1) {
        spreadsheet.deleteSheet(sheet);
      }
    });

    step = "dar formato al encabezado";
    responseTab.setName("Pedidos proveedor");
    const expectedLastColumn = 3 + questionCount;
    const lastColumn = Math.max(responseTab.getLastColumn(), expectedLastColumn);
    const visibleHeader = responseTab.getRange(1, 3, 1, lastColumn - 2);
    visibleHeader
      .setBackground("#5B2A86")
      .setFontColor("#FFFFFF")
      .setFontWeight("bold")
      .setHorizontalAlignment("left")
      .setVerticalAlignment("middle")
      .setWrap(true);
    responseTab.setRowHeight(1, 32);
    responseTab.setFrozenRows(1);

    step = "ocultar fecha y correo";
    responseTab.hideColumns(1, 2);
    responseTab.setColumnWidth(3, 210);
    if (lastColumn > 3) responseTab.setColumnWidths(4, lastColumn - 3, 230);

    SpreadsheetApp.flush();
  } catch (error) {
    throw new Error("No se pudo " + step + ": " + (error && error.message ? error.message : error));
  }
}

function extractSpreadsheetId_(url) {
  const match = String(url || "").match(/\/spreadsheets\/d\/([^/]+)/);
  return match ? match[1] : "";
}

function buildSpreadsheetDownloadUrl_(spreadsheetId) {
  return spreadsheetId ? "https://docs.google.com/spreadsheets/d/" + spreadsheetId + "/export?format=xlsx" : "";
}

function closeExpiredMealForms() {
  const properties = PropertiesService.getScriptProperties();
  const registry = JSON.parse(properties.getProperty(EXPIRATION_REGISTRY_KEY) || "{}");
  const now = new Date();
  Object.keys(registry).forEach(function (formId) {
    if (new Date(registry[formId]).getTime() <= now.getTime()) {
      try {
        FormApp.openById(formId).setAcceptingResponses(false);
      } finally {
        delete registry[formId];
      }
    }
  });
  properties.setProperty(EXPIRATION_REGISTRY_KEY, JSON.stringify(registry));
}

function registerExpiration_(formId, closeAtLocal) {
  const properties = PropertiesService.getScriptProperties();
  const registry = JSON.parse(properties.getProperty(EXPIRATION_REGISTRY_KEY) || "{}");
  registry[formId] = closeAtLocal;
  properties.setProperty(EXPIRATION_REGISTRY_KEY, JSON.stringify(registry));
}

function ensureExpirationTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === "closeExpiredMealForms";
  });
  if (!exists) ScriptApp.newTrigger("closeExpiredMealForms").timeBased().everyMinutes(15).create();
}

function validatePayload_(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Solicitud inválida.");
  if (!/^[a-f0-9]{64}$/.test(payload.requestId || "")) throw new Error("Identificador inválido.");
  if (typeof payload.title !== "string" || !payload.title.trim()) throw new Error("El título es obligatorio.");
  if (!Array.isArray(payload.questions) || payload.questions.length < 1 || payload.questions.length > 5) throw new Error("Las preguntas del menú no son válidas.");
  if (Number.isNaN(new Date(payload.closeAtLocal).getTime())) throw new Error("La fecha de cierre no es válida.");
  if (!Number.isInteger(payload.reminderAfterHours) || payload.reminderAfterHours < 0 || payload.reminderAfterHours > 168) throw new Error("El plazo del recordatorio no es válido.");
  if (!Array.isArray(payload.employeeNames) || payload.employeeNames.length < 1 || payload.employeeNames.length > 500) throw new Error("La nómina activa no es válida.");
  payload.employeeNames.forEach(function (name) {
    if (typeof name !== "string" || !name.trim() || name.length > 160) throw new Error("La nómina activa contiene un nombre inválido.");
  });
  if (payload.omittedDays && !Array.isArray(payload.omittedDays)) throw new Error("Los días omitidos no son válidos.");
  payload.questions.forEach(function (question) {
    if (!question.title || !Array.isArray(question.options) || question.options.length < 2) throw new Error("Una pregunta del menú está incompleta.");
  });
  return payload;
}

function jsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
