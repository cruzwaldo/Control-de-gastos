(() => {
  'use strict';

  const STORAGE_KEY = 'controlgastos:state:v1';

  const Utils = {
    money(value) {
      const amount = Number.isFinite(value) ? value : 0;
      return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: 'COP',
        maximumFractionDigits: 0
      }).format(amount);
    },

    number(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    },

    uid() {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    },

    monthKey(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      return `${year}-${month}`;
    },

    nextMonthKey(key) {
      const [year, month] = key.split('-').map(Number);
      return Utils.monthKey(new Date(year, month, 1));
    },

    monthLabel(key) {
      const [year, month] = key.split('-').map(Number);
      const date = new Date(year, month - 1, 1);
      const label = new Intl.DateTimeFormat('es-CO', {
        month: 'long',
        year: 'numeric'
      }).format(date);
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
  };

  const Model = {
    defaults() {
      return {
        salary: 0,
        monthlyLimit: 0,
        theme: null,
        period: Utils.monthKey(new Date()),
        extraIncomes: [],
        expenses: [],
        emergencyAllocation: 0,
        emergencyFund: 0,
        savingsGoals: [],
        history: []
      };
    },

    normalize(raw) {
      const base = Model.defaults();
      if (!raw || typeof raw !== 'object') return base;

      return {
        salary: Utils.number(raw.salary),
        monthlyLimit: Utils.number(raw.monthlyLimit),
        theme: raw.theme === 'dark' || raw.theme === 'light' ? raw.theme : base.theme,
        period: /^\d{4}-\d{2}$/.test(raw.period) ? raw.period : base.period,
        extraIncomes: Array.isArray(raw.extraIncomes) ? raw.extraIncomes : [],
        expenses: Array.isArray(raw.expenses)
          ? raw.expenses.map((item) => {
            const entry = item && typeof item === 'object' ? item : {};
            return {
              ...entry,
              paid: entry.type !== 'fixed' || entry.paid === true || entry.paid === undefined
            };
          })
          : [],
        emergencyAllocation: Utils.number(raw.emergencyAllocation),
        emergencyFund: Utils.number(raw.emergencyFund),
        savingsGoals: Array.isArray(raw.savingsGoals) ? raw.savingsGoals : [],
        history: Array.isArray(raw.history) ? raw.history : []
      };
    }
  };

  const Storage = {
    load() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return Model.normalize(stored ? JSON.parse(stored) : null);
      } catch (error) {
        console.warn('No se pudo leer el almacenamiento local.', error);
        return Model.defaults();
      }
    },

    save(state) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (error) {
        console.warn('No se pudo guardar en el almacenamiento local.', error);
      }
    }
  };

  const Calculations = {
    totalIncome(state) {
      const extras = state.extraIncomes.reduce((sum, item) => sum + Utils.number(item.amount), 0);
      return state.salary + extras;
    },

    fixedExpenses(state) {
      return state.expenses
        .filter((item) => item.type === 'fixed' && item.paid === true)
        .reduce((sum, item) => sum + Utils.number(item.amount), 0);
    },

    pendingFixedExpenses(state) {
      return state.expenses.filter((item) => item.type === 'fixed' && item.paid !== true);
    },

    extraExpenses(state) {
      return state.expenses
        .filter((item) => item.type === 'extra')
        .reduce((sum, item) => sum + Utils.number(item.amount), 0);
    },

    totalExpenses(state) {
      return Calculations.fixedExpenses(state) + Calculations.extraExpenses(state);
    },

    availableLimit(state) {
      return Utils.number(state.monthlyLimit) - Calculations.fixedExpenses(state);
    },

    activeGoals(state) {
      return state.savingsGoals.filter((goal) => {
        const target = Utils.number(goal.target);
        return target === 0 || Utils.number(goal.saved) < target;
      });
    },

    monthlySavings(state) {
      return Calculations.activeGoals(state).reduce((sum, goal) => sum + Utils.number(goal.monthly), 0);
    },

    balance(state) {
      return (
        Calculations.totalIncome(state) -
        Calculations.totalExpenses(state) -
        Utils.number(state.emergencyAllocation) -
        Calculations.monthlySavings(state)
      );
    },

    limitStatus(state) {
      const fixed = Calculations.fixedExpenses(state);
      const extra = Calculations.extraExpenses(state);
      const available = Calculations.availableLimit(state);

      if (Utils.number(state.monthlyLimit) === 0) {
        return { level: 'none', ratio: 0, percent: 0, available: 0, fixed, extra };
      }

      if (available <= 0) {
        return { level: 'danger', ratio: 1, percent: 100, available: 0, fixed, extra };
      }

      const ratio = extra / available;
      let level = 'ok';
      if (ratio >= 1) level = 'danger';
      else if (ratio >= 0.9) level = 'warning';

      return { level, ratio, percent: Math.round(ratio * 100), available, fixed, extra };
    }
  };

  const Month = {
    close(state, periodKey) {
      const expenses = Calculations.totalExpenses(state);
      const extra = Calculations.extraExpenses(state);
      const available = Math.max(0, Calculations.availableLimit(state));
      const emergencySavedThisMonth = Utils.number(state.emergencyAllocation);
      const goalsContribution = Calculations.monthlySavings(state);
      const leftover = Math.max(0, available - extra);
      const finalBalance = Calculations.balance(state);

      const activeGoals = Calculations.activeGoals(state);
      activeGoals.forEach((goal) => {
        goal.saved = Utils.number(goal.saved) + Utils.number(goal.monthly);
      });

      state.emergencyFund = Utils.number(state.emergencyFund) + leftover;

      state.history.push({
        month: periodKey,
        totalIncome: Calculations.totalIncome(state),
        totalExpenses: expenses,
        fixedExpenses: Calculations.fixedExpenses(state),
        extraExpenses: Calculations.extraExpenses(state),
        emergencySaved: emergencySavedThisMonth + leftover,
        autoEmergency: leftover,
        goalsSaved: goalsContribution,
        balance: finalBalance
      });

      state.extraIncomes = [];
      state.expenses = [];
      state.emergencyAllocation = 0;
      state.period = Utils.nextMonthKey(periodKey);

      return leftover;
    },

    autoClose(state) {
      const current = Utils.monthKey(new Date());
      let lastLeftover = null;
      let guard = 0;

      while (state.period < current && guard < 24) {
        lastLeftover = Month.close(state, state.period);
        guard += 1;
      }

      return lastLeftover;
    }
  };

  const CATEGORIES = {
    fixed: ['Arriendo', 'Subscripciones', 'Mensualidades', 'Créditos', 'Otros fijos'],
    extra: ['Salidas', 'Emergencias', 'Unas polas', 'Otros extras']
  };

  const UI = {
    notice: null,
    elements: {},

    cacheElements() {
      const ids = [
        'theme-toggle', 'theme-icon', 'theme-label',
        'period-label', 'balance-amount', 'balance-note', 'limit-bar', 'limit-text',
        'stat-income', 'stat-expenses', 'stat-emergency', 'stat-goals',
        'alert-zone', 'salary-input', 'limit-input', 'salary-form',
        'income-form', 'income-amount', 'income-category', 'income-note', 'income-list',
        'expense-form', 'expense-category', 'expense-amount', 'expense-note', 'expense-list',
        'emergency-form', 'emergency-amount', 'emergency-fund', 'emergency-this-month',
        'goal-form', 'goal-name', 'goal-monthly', 'goal-target', 'goal-list',
        'close-month', 'history-body'
      ];
      ids.forEach((id) => {
        UI.elements[id] = document.getElementById(id);
      });
    },

    setNotice(message, type) {
      UI.notice = { message, type };
    },

    clearNotice() {
      UI.notice = null;
    },

    applyTheme(theme) {
      const isDark = theme === 'dark';
      document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
      const button = UI.elements['theme-toggle'];
      button.setAttribute('aria-pressed', String(isDark));
      button.setAttribute('aria-label', isDark ? 'Activar modo claro' : 'Activar modo oscuro');
      UI.elements['theme-icon'].textContent = isDark ? '☀' : '☾';
      UI.elements['theme-label'].textContent = isDark ? 'Modo claro' : 'Modo oscuro';
    },

    createRecord({ title, meta, amount, amountClass, actionable, action, id, payable }) {
      const item = document.createElement('li');
      item.className = 'record';

      const info = document.createElement('div');
      info.className = 'record-info';

      const titleEl = document.createElement('p');
      titleEl.className = 'record-title';
      titleEl.textContent = title;

      const metaEl = document.createElement('p');
      metaEl.className = 'record-meta';
      metaEl.textContent = meta;

      info.append(titleEl, metaEl);

      const actions = document.createElement('div');
      actions.className = 'record-actions';

      const amountEl = document.createElement('span');
      amountEl.className = `record-amount ${amountClass || ''}`.trim();
      amountEl.textContent = amount;

      actions.append(amountEl);

      if (payable) {
        const payButton = document.createElement('button');
        payButton.type = 'button';
        payButton.className = 'pay-btn';
        payButton.dataset.action = 'pay-expense';
        payButton.dataset.id = id;
        payButton.setAttribute('aria-label', `Pagar ${title}`);
        payButton.textContent = 'Pagar';
        actions.append(payButton);
      }

      if (actionable) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'icon-btn';
        button.setAttribute('aria-label', `Eliminar ${title}`);
        button.dataset.action = action;
        button.dataset.id = id;
        button.textContent = '×';
        actions.append(button);
      }

      item.append(info, actions);
      return item;
    },

    renderIncomes(state) {
      const list = UI.elements['income-list'];
      list.replaceChildren();

      [...state.extraIncomes].reverse().forEach((income) => {
        const label = (income.note || '').trim() || income.category;
        list.append(UI.createRecord({
          title: label,
          meta: income.category,
          amount: `+ ${Utils.money(income.amount)}`,
          amountClass: 'positive',
          actionable: true,
          action: 'delete-income',
          id: income.id
        }));
      });
    },

    renderExpenses(state) {
      const list = UI.elements['expense-list'];
      list.replaceChildren();

      [...state.expenses].reverse().forEach((expense) => {
        const label = (expense.note || '').trim() || expense.category;
        const isFixed = expense.type === 'fixed';
        const isPaid = expense.paid === true;
        const item = UI.createRecord({
          title: label,
          meta: `${isFixed ? 'Fijo' : 'Extra'} · ${expense.category}`,
          amount: `- ${Utils.money(expense.amount)}`,
          amountClass: isFixed && !isPaid ? 'pending' : 'negative',
          actionable: true,
          action: 'delete-expense',
          id: expense.id,
          payable: isFixed && !isPaid
        });

        if (isFixed) {
          const badge = document.createElement('span');
          badge.className = `badge badge-${isPaid ? 'paid' : 'pending'}`;
          badge.textContent = isPaid ? 'Pagado' : 'Pendiente';
          item.querySelector('.record-meta').append(' · ', badge);
        }

        list.append(item);
      });
    },

    renderGoals(state) {
      const list = UI.elements['goal-list'];
      list.replaceChildren();

      state.savingsGoals.forEach((goal) => {
        const saved = Utils.number(goal.saved);
        const target = Utils.number(goal.target);
        const item = UI.createRecord({
          title: goal.name,
          meta: target > 0
            ? `${Utils.money(goal.monthly)} / mes · ${Utils.money(saved)} de ${Utils.money(target)}`
            : `${Utils.money(goal.monthly)} / mes · ${Utils.money(saved)} ahorrados`,
          amount: Utils.money(goal.monthly),
          amountClass: 'positive',
          actionable: true,
          action: 'delete-goal',
          id: goal.id
        });

        if (target > 0) {
          const progress = document.createElement('div');
          progress.className = 'goal-progress';
          const fill = document.createElement('span');
          fill.style.width = `${Math.min(100, (saved / target) * 100)}%`;
          progress.append(fill);
          item.querySelector('.record-info').append(progress);
        }

        list.append(item);
      });
    },

    renderHistory(state) {
      const body = UI.elements['history-body'];
      body.replaceChildren();

      if (state.history.length === 0) {
        const row = document.createElement('tr');
        row.className = 'empty-row';
        const cell = document.createElement('td');
        cell.colSpan = 6;
        cell.textContent = 'Cierra tu primer mes para ver el resumen aquí.';
        row.append(cell);
        body.append(row);
        return;
      }

      [...state.history].reverse().forEach((entry) => {
        const row = document.createElement('tr');
        const values = [
          Utils.monthLabel(entry.month),
          Utils.money(entry.totalIncome),
          Utils.money(entry.totalExpenses),
          Utils.money(entry.emergencySaved),
          Utils.money(entry.goalsSaved),
          Utils.money(entry.balance)
        ];
        values.forEach((value, index) => {
          const cell = document.createElement('td');
          cell.textContent = value;
          if (index === 0) cell.scope = 'row';
          row.append(cell);
        });
        body.append(row);
      });
    },

    renderAlerts(state) {
      const zone = UI.elements['alert-zone'];
      zone.replaceChildren();

      const addAlert = (message, type) => {
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        const text = document.createElement('p');
        text.textContent = message;
        alert.append(text);
        zone.append(alert);
      };

      if (UI.notice) {
        addAlert(UI.notice.message, UI.notice.type);
      }

      const pending = Calculations.pendingFixedExpenses(state);
      if (pending.length > 0) {
        const total = pending.reduce((sum, item) => sum + Utils.number(item.amount), 0);
        addAlert(
          `Tienes ${pending.length} gasto(s) fijo(s) pendiente(s) por ${Utils.money(total)}. Págalos para descontarlos del saldo.`,
          'info'
        );
      }

      const status = Calculations.limitStatus(state);

      if (status.level === 'danger') {
        const message = status.available === 0
          ? `Límite superado: tus gastos fijos (${Utils.money(status.fixed)}) ya cubren el límite mensual (${Utils.money(state.monthlyLimit)}).`
          : `Límite superado: has gastado ${Utils.money(status.extra)} en gastos extra de ${Utils.money(status.available)} disponibles tras gastos fijos.`;
        addAlert(message, 'danger');
      } else if (status.level === 'warning') {
        addAlert(
          `Atención: tus gastos extra ya son el ${status.percent}% del límite disponible (${Utils.money(status.extra)} de ${Utils.money(status.available)}).`,
          'warning'
        );
      }
    },

    renderSummary(state) {
      const el = UI.elements;
      const status = Calculations.limitStatus(state);
      const balance = Calculations.balance(state);

      el['period-label'].textContent = Utils.monthLabel(state.period);
      el['balance-amount'].textContent = Utils.money(balance);
      el['balance-amount'].classList.toggle('is-negative', balance < 0);

      if (state.salary === 0) {
        el['balance-note'].textContent = 'Comienza registrando tu salario.';
      } else if (balance < 0) {
        el['balance-note'].textContent = 'Tus salidas superan a tus entradas este mes.';
      } else {
        el['balance-note'].textContent = 'Disponible después de gastos, emergencias y metas.';
      }

      el['stat-income'].textContent = Utils.money(Calculations.totalIncome(state));
      el['stat-expenses'].textContent = Utils.money(Calculations.totalExpenses(state));
      el['stat-emergency'].textContent = Utils.money(state.emergencyFund);
      el['stat-goals'].textContent = Utils.money(Calculations.monthlySavings(state));

      el['limit-bar'].style.width = `${Math.min(100, status.ratio * 100)}%`;
      el['limit-bar'].classList.toggle('is-warning', status.level === 'warning');
      el['limit-bar'].classList.toggle('is-danger', status.level === 'danger');

      el['limit-text'].textContent = status.level === 'none'
        ? 'Límite mensual sin definir'
        : `Límite usado: ${status.percent}% de ${Utils.money(status.available)} tras fijos`;

      el['emergency-fund'].textContent = Utils.money(state.emergencyFund);
      el['emergency-this-month'].textContent = `Apartado este mes: ${Utils.money(state.emergencyAllocation)}`;
    },

    renderCategories(type) {
      const select = UI.elements['expense-category'];
      select.replaceChildren();
      CATEGORIES[type].forEach((category) => {
        const option = document.createElement('option');
        option.value = category;
        option.textContent = category;
        select.append(option);
      });
    },

    render(state) {
      UI.renderSummary(state);
      UI.renderAlerts(state);
      UI.renderIncomes(state);
      UI.renderExpenses(state);
      UI.renderGoals(state);
      UI.renderHistory(state);
    }
  };

  const App = {
    state: null,

    persist() {
      Storage.save(App.state);
      UI.render(App.state);
    },

    selectedExpenseType() {
      return document.querySelector('input[name="expense-type"]:checked').value;
    },

    bindEvents() {
      const el = UI.elements;

      el['theme-toggle'].addEventListener('click', () => {
        App.state.theme = App.state.theme === 'dark' ? 'light' : 'dark';
        UI.applyTheme(App.state.theme);
        Storage.save(App.state);
      });

      el['salary-form'].addEventListener('submit', (event) => {
        event.preventDefault();
        App.state.salary = Utils.number(el['salary-input'].value);
        App.state.monthlyLimit = Utils.number(el['limit-input'].value);
        UI.clearNotice();
        App.persist();
      });

      el['income-form'].addEventListener('submit', (event) => {
        event.preventDefault();
        const amount = Utils.number(el['income-amount'].value);
        if (amount === 0) return;
        App.state.extraIncomes.push({
          id: Utils.uid(),
          amount,
          category: el['income-category'].value,
          note: el['income-note'].value.trim(),
          date: new Date().toISOString()
        });
        el['income-form'].reset();
        UI.clearNotice();
        App.persist();
      });

      el['expense-form'].addEventListener('submit', (event) => {
        event.preventDefault();
        const amount = Utils.number(el['expense-amount'].value);
        if (amount === 0) return;
        const type = App.selectedExpenseType();
        App.state.expenses.push({
          id: Utils.uid(),
          type,
          category: el['expense-category'].value,
          amount,
          note: el['expense-note'].value.trim(),
          date: new Date().toISOString(),
          paid: type === 'extra'
        });
        el['expense-form'].reset();
        UI.renderCategories(type);
        UI.clearNotice();
        App.persist();
      });

      document.querySelectorAll('input[name="expense-type"]').forEach((radio) => {
        radio.addEventListener('change', () => UI.renderCategories(App.selectedExpenseType()));
      });

      el['emergency-form'].addEventListener('submit', (event) => {
        event.preventDefault();
        const amount = Utils.number(el['emergency-amount'].value);
        if (amount === 0) return;
        App.state.emergencyAllocation += amount;
        App.state.emergencyFund += amount;
        el['emergency-form'].reset();
        UI.clearNotice();
        App.persist();
      });

      el['goal-form'].addEventListener('submit', (event) => {
        event.preventDefault();
        const monthly = Utils.number(el['goal-monthly'].value);
        const name = el['goal-name'].value.trim();
        if (monthly === 0 || name === '') return;
        App.state.savingsGoals.push({
          id: Utils.uid(),
          name,
          monthly,
          target: Utils.number(el['goal-target'].value),
          saved: 0
        });
        el['goal-form'].reset();
        UI.clearNotice();
        App.persist();
      });

      el['close-month'].addEventListener('click', () => {
        const pendingCount = Calculations.pendingFixedExpenses(App.state).length;
        const warning = pendingCount > 0
          ? ` Hay ${pendingCount} gasto(s) fijo(s) pendiente(s) que no se contabilizarán.`
          : '';
        const confirmed = window.confirm(
          `¿Cerrar ${Utils.monthLabel(App.state.period)}?${warning} Se archivará el resumen y comenzará un mes nuevo.`
        );
        if (!confirmed) return;

        const leftover = Month.close(App.state, App.state.period);
        Storage.save(App.state);
        UI.setNotice(
          `Mes cerrado. ${Utils.money(leftover)} del límite no gastado se destinaron a emergencias.`,
          'info'
        );
        UI.render(App.state);
      });

      ['income-list', 'expense-list', 'goal-list'].forEach((listId) => {
        el[listId].addEventListener('click', (event) => {
          const button = event.target.closest('button[data-action]');
          if (!button) return;

          const { action, id } = button.dataset;
          if (action === 'delete-income') {
            App.state.extraIncomes = App.state.extraIncomes.filter((item) => item.id !== id);
          } else if (action === 'delete-expense') {
            App.state.expenses = App.state.expenses.filter((item) => item.id !== id);
          } else if (action === 'pay-expense') {
            const expense = App.state.expenses.find((item) => item.id === id);
            if (expense) expense.paid = true;
          } else if (action === 'delete-goal') {
            App.state.savingsGoals = App.state.savingsGoals.filter((item) => item.id !== id);
          }
          UI.clearNotice();
          App.persist();
        });
      });
    },

    init() {
      UI.cacheElements();
      App.state = Storage.load();

      if (App.state.theme !== 'dark' && App.state.theme !== 'light') {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        App.state.theme = prefersDark ? 'dark' : 'light';
        Storage.save(App.state);
      }
      UI.applyTheme(App.state.theme);

      const leftover = Month.autoClose(App.state);
      if (leftover !== null) {
        Storage.save(App.state);
        UI.setNotice(
          `Mes anterior archivado. ${Utils.money(leftover)} sobrantes del límite se destinaron a emergencias.`,
          'info'
        );
      }

      UI.elements['salary-input'].value = App.state.salary || '';
      UI.elements['limit-input'].value = App.state.monthlyLimit || '';
      UI.renderCategories(App.selectedExpenseType());
      UI.render(App.state);
      App.bindEvents();
    }
  };

  App.init();
})();
