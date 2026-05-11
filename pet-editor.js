// Pet Editor: overlay UI for managing pets, animation states, and gallery.

const dog = document.getElementById('dog');

// Prevent Electron from navigating to dropped files
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

export function init(state) {
  const overlay = document.getElementById('pet-editor');
  const closeBtn = document.getElementById('editor-close');
  const openBtn = document.getElementById('editor-toggle');
  const editorMenu = document.getElementById('editor-menu');
  const statePanel = document.getElementById('state-editor-panel');
  const stateBackBtn = document.getElementById('state-editor-back');
  const editPetName = document.getElementById('edit-pet-name');
  const addBtn = document.getElementById('btn-add-pet');
  const editBtn = document.getElementById('btn-edit-pet');
  const endSessionBtn = document.getElementById('btn-end-session');
  const galleryLabel = overlay.querySelector('.gallery-label');
  const gallery = document.getElementById('pet-gallery');
  const stateBoxes = overlay.querySelectorAll('.state-box');

  let currentPets = [];
  let activePetId = null;

  function updateDogTitle() {
    const pet = currentPets.find((p) => p.id === activePetId);
    dog.title = pet ? pet.name : '';
  }

  function showGallery(visible) {
    galleryLabel.style.display = visible ? '' : 'none';
    gallery.style.display = visible ? '' : 'none';
  }

  function showMenu() {
    editorMenu.classList.add('show');
    statePanel.classList.remove('show');
    showGallery(true);
  }

  function showStateEditor() {
    editorMenu.classList.remove('show');
    statePanel.classList.add('show');
    showGallery(false);
    const pet = currentPets.find((p) => p.id === activePetId);
    editPetName.value = pet ? pet.name : '';
    renderStateBoxes();
  }

  function open() {
    window.agent.resizeWindow(280, 800);
    overlay.classList.add('show');
    showMenu();
    refresh();
  }

  function close() {
    overlay.classList.remove('show');
    showMenu();
    window.agent.resizeWindow(280, 540);
  }

  openBtn.onclick = open;
  closeBtn.onclick = close;
  dog.addEventListener('dblclick', open);
  editBtn.onclick = showStateEditor;
  stateBackBtn.onclick = showMenu;

  // Save name on blur or Enter
  editPetName.onblur = async () => {
    const newName = editPetName.value.trim();
    const pet = currentPets.find((p) => p.id === activePetId);
    if (pet && newName && newName !== pet.name) {
      await window.agent.petsRename(activePetId, newName);
      await refresh();
      updateDogTitle();
    }
  };
  editPetName.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); editPetName.blur(); }
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) {
      if (statePanel.classList.contains('show')) {
        showMenu();
      } else {
        close();
      }
    }
  });

  async function refresh() {
    const data = await window.agent.petsList();
    currentPets = data.pets;
    activePetId = data.activePetId;
    if (statePanel.classList.contains('show')) renderStateBoxes();
    renderGallery();
    updateDogTitle();
  }

  function renderStateBoxes() {
    const activePet = currentPets.find((p) => p.id === activePetId);
    if (!activePet) return;

    stateBoxes.forEach((box) => {
      const stateName = box.dataset.state;
      const preview = box.querySelector('.state-preview');
      const removeX = box.querySelector('.state-remove');
      const imgUrl = activePet.resolvedStates[stateName];

      if (imgUrl) {
        preview.src = imgUrl;
        preview.style.display = 'block';
        box.classList.add('has-image');
      } else {
        preview.src = '';
        preview.style.display = 'none';
        box.classList.remove('has-image');
      }

      // Click to upload via file dialog
      box.onclick = async (e) => {
        if (e.target === removeX || removeX.contains(e.target)) return;
        const result = await window.agent.petsUploadState(activePetId, stateName);
        if (result && !result.error) {
          await refresh();
          await state.reloadPet();
        }
      };

      // X button to remove
      removeX.onclick = async (e) => {
        e.stopPropagation();
        const result = await window.agent.petsRemoveState(activePetId, stateName);
        if (result) {
          await refresh();
          await state.reloadPet();
        }
      };

      // Drag and drop
      box.ondragover = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        box.classList.add('drag-over');
      };
      box.ondragleave = () => {
        box.classList.remove('drag-over');
      };
      box.ondrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        box.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (!file) return;
        const filePath = window.agent.getFilePath(file) || file.path;
        if (!filePath) return;
        const result = await window.agent.petsDropState(activePetId, stateName, filePath);
        if (result && !result.error) {
          await refresh();
          await state.reloadPet();
        }
      };
    });
  }

  function renderGallery() {
    gallery.innerHTML = '';
    currentPets.forEach((pet) => {
      const item = document.createElement('div');
      item.className = 'gallery-item' + (pet.id === activePetId ? ' active' : '');

      const idleSrc = pet.resolvedStates.idle || 'assets/default-pet.png';
      const hoverSrc = pet.resolvedStates.responseNeeded || idleSrc;
      const img = document.createElement('img');
      img.src = idleSrc;
      img.alt = pet.name;
      item.appendChild(img);

      if (hoverSrc !== idleSrc) {
        item.onmouseenter = () => { img.src = hoverSrc; };
        item.onmouseleave = () => { img.src = idleSrc; };
      }

      const name = document.createElement('span');
      name.className = 'gallery-name';
      name.textContent = pet.name;
      item.appendChild(name);

      // Double-click name to rename
      name.ondblclick = async (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.className = 'gallery-name-input';
        input.value = pet.name;
        name.replaceWith(input);
        input.focus();
        input.select();

        const commit = async () => {
          const newName = input.value.trim();
          if (newName && newName !== pet.name) {
            await window.agent.petsRename(pet.id, newName);
            await refresh();
            updateDogTitle();
          } else {
            input.replaceWith(name);
          }
        };
        input.onblur = commit;
        input.onkeydown = (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
          if (ev.key === 'Escape') { input.value = pet.name; input.blur(); }
        };
      };

      // Click to select
      item.onclick = async () => {
        window.agent.petsSetActive(pet.id);
        activePetId = pet.id;
        await state.reloadPet();
        if (statePanel.classList.contains('show')) renderStateBoxes();
        renderGallery();
        updateDogTitle();
      };

      if (!pet.builtIn) {
        const del = document.createElement('button');
        del.className = 'gallery-delete';
        del.title = 'Delete pet';
        del.innerHTML = '&times;';
        del.onclick = async (e) => {
          e.stopPropagation();
          await window.agent.petsDelete(pet.id);
          await refresh();
          await state.reloadPet();
        };
        item.appendChild(del);
      }

      gallery.appendChild(item);
    });
  }

  // Add Pet: create empty pet and open state editor immediately
  addBtn.onclick = async () => {
    const result = await window.agent.petsAddEmpty();
    if (result && !result.error) {
      await refresh();
      await state.reloadPet();
      showStateEditor();
      editPetName.focus();
      editPetName.select();
    }
  };

  // End Session (in settings panel)
  endSessionBtn.onclick = () => {
    window.agent.exitSession();
  };
}
