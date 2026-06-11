(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  }else{
    root.LargeEnterpriseFilter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  const DEFAULT_FIELDS = [
    'brand',
    'operator',
    'network',
    'name',
    'official_name',
    'short_name',
    'alt_name'
  ];

  const EMPLOYEE_FIELDS = [
    'employees',
    'employee_count',
    'staff',
    'staff_count',
    'number_of_employees',
    'dipendenti'
  ];

  const TURNOVER_FIELDS = [
    'turnover',
    'annual_turnover',
    'revenue',
    'annual_revenue',
    'fatturato'
  ];

  const LARGE_ENTERPRISE_EMPLOYEE_THRESHOLD = 250;
  const LARGE_ENTERPRISE_TURNOVER_THRESHOLD = 50000000;

  function normalizeText(value){
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' ')
      .replace(/['']/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeRegExp(value){
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseNumber(value){
    if(value === undefined || value === null || value === '') return null;
    if(typeof value === 'number') return Number.isFinite(value) ? value : null;

    const raw = String(value).trim();
    if(!raw) return null;

    const hasMillionUnit = /\b(mln|million|milione|milioni)\b/i.test(raw) || /\d\s*m\b/i.test(raw);
    const match = raw.match(/\d+(?:[.,]\d+)*(?:[.,]\d+)?/);
    if(!match) return null;

    let token = match[0];
    if(/^\d{1,3}([.,]\d{3})+$/.test(token)){
      token = token.replace(/[.,]/g, '');
    }else{
      token = token.replace(',', '.');
    }

    const number = Number(token);
    if(!Number.isFinite(number)) return null;
    return hasMillionUnit && number < 1000000 ? number * 1000000 : number;
  }

  function firstParsedNumber(properties, fields){
    for(const field of fields){
      const parsed = parseNumber(properties[field]);
      if(parsed !== null) return parsed;
    }
    return null;
  }

  function findDeclaredLargeEnterprise(properties, options = {}){
    const employeeThreshold = options.employeeThreshold || LARGE_ENTERPRISE_EMPLOYEE_THRESHOLD;
    const turnoverThreshold = options.turnoverThreshold || LARGE_ENTERPRISE_TURNOVER_THRESHOLD;
    const employees = firstParsedNumber(properties, EMPLOYEE_FIELDS);
    const turnover = firstParsedNumber(properties, TURNOVER_FIELDS);

    if(employees !== null && turnover !== null && employees > employeeThreshold && turnover > turnoverThreshold){
      return {
        label: 'Grande impresa dichiarata',
        reason: 'declared_size',
        employees,
        turnover,
        employeeThreshold,
        turnoverThreshold
      };
    }

    return null;
  }

  function normalizeRules(rules){
    if(Array.isArray(rules)) return rules;
    if(rules && Array.isArray(rules.rules)) return rules.rules;
    return [];
  }

  function matchTerm(normalizedValue, term){
    const normalizedTerm = normalizeText(term);
    if(!normalizedValue || !normalizedTerm) return false;
    const re = new RegExp('(^|\\s)' + escapeRegExp(normalizedTerm) + '(\\s|$)');
    return re.test(normalizedValue);
  }

  function matchExactTerm(normalizedValue, term){
    const normalizedTerm = normalizeText(term);
    return Boolean(normalizedValue && normalizedTerm && normalizedValue === normalizedTerm);
  }

  function findBrandRule(properties, rules, options = {}){
    const fields = options.fields || DEFAULT_FIELDS;
    const normalizedRules = normalizeRules(rules);

    for(const rule of normalizedRules){
      const terms = Array.isArray(rule.terms) ? rule.terms : [];
      const exactTerms = Array.isArray(rule.exactTerms) ? rule.exactTerms : [];
      for(const field of fields){
        const normalizedValue = normalizeText(properties[field]);
        if(!normalizedValue) continue;

        const exactTerm = exactTerms.find(term => matchExactTerm(normalizedValue, term));
        if(exactTerm){
          return {
            label: rule.label || exactTerm,
            reason: 'known_large_enterprise',
            field,
            term: exactTerm
          };
        }

        const term = terms.find(candidate => matchTerm(normalizedValue, candidate));
        if(term){
          return {
            label: rule.label || term,
            reason: 'known_large_enterprise',
            field,
            term
          };
        }
      }
    }

    return null;
  }

  function findRule(properties = {}, rules = [], options = {}){
    return findDeclaredLargeEnterprise(properties, options) || findBrandRule(properties, rules, options);
  }

  return {
    normalizeText,
    parseNumber,
    findDeclaredLargeEnterprise,
    findBrandRule,
    findRule
  };
});
